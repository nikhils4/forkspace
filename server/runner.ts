import { SAFETY_RULES, check, safetyHooks } from './guard.ts';
import { query, type CanUseTool, type PermissionResult, type PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import path from 'node:path';
import type { Attachment, Board, Branch, PendingPermission, Position, TurnEvent, TurnNode } from '../shared/types.ts';
import { INLINE_IMAGE_MAX, attachmentPath, imageBytes } from './attachments.ts';
import * as g from './git.ts';
import { commitMessage, threadTitle } from './tutor.ts';
import { capture } from './shots.ts';
import { ensureSessionAt } from './sessions.ts';
import { HOME, getBoard, getBranch, getTurn, save, state } from './store.ts';

type Emit = (msg: import('../shared/types.ts').ServerMsg) => void;
let emit: Emit = () => {};
export const setEmitter = (fn: Emit) => (emit = fn);

interface Pending extends PendingPermission {
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

interface Running {
  abort: AbortController;
  queue: Pending[];
  showNext: () => void;
}

const running = new Map<string, Running>();

type Activity = (node: TurnNode, final?: boolean) => void;
let activityFn: Activity = () => {};
export const setActivityHook = (fn: Activity) => (activityFn = fn);

type Notify = (node: TurnNode, kind: 'waiting' | 'finished') => void;
let notifyFn: Notify = () => {};
export const setNotifier = (fn: Notify) => (notifyFn = fn);

// ---- throttled node broadcast ----
const dirty = new Set<string>();
let flushTimer: NodeJS.Timeout | null = null;
export function touch(node: TurnNode) {
  dirty.add(node.id);
  save();
  if (!flushTimer)
    flushTimer = setTimeout(() => {
      flushTimer = null;
      for (const id of dirty) {
        const n = getTurn(id);
        if (n) emit({ type: 'node', node: n });
      }
      dirty.clear();
    }, 60);
}

// ---- branches ----

async function newBranch(board: Board, from: string | null): Promise<Branch> {
  const id = nanoid(8);
  const branch: Branch = { id, boardId: board.id, cwd: board.cwd };
  if (board.isolation === 'worktree' && board.repoRoot) {
    const worktree = path.join(HOME, 'worktrees', board.id, id);
    const gitBranch = `forkspace/${id}`;
    await g.addWorktree(board.repoRoot, worktree, gitBranch, from ?? 'HEAD');
    branch.worktree = worktree;
    branch.gitBranch = gitBranch;
    branch.cwd = board.relPath ? path.join(worktree, board.relPath) : worktree;
  }
  state.branches.push(branch);
  emit({ type: 'branch', branch });
  return branch;
}

async function pickBranch(board: Board, parent: TurnNode | null): Promise<Branch> {
  if (!parent) return newBranch(board, null);
  const pb = getBranch(parent.branchId);
  // Replying to the latest turn of a branch continues it; anything else forks.
  if (pb && pb.headNodeId === parent.id) return pb;
  // Imported steps have no checkpoint: a branch from one starts from the folder's current commit.
  if (board.isolation === 'worktree' && board.repoRoot && !parent.commit && !parent.imported)
    throw new Error('That turn has no checkpoint, so it cannot be forked.');
  // Branching from an imported step: start from the folder as it is now, uncommitted work included.
  if (parent.imported && !parent.commit && board.isolation === 'worktree' && board.repoRoot)
    return newBranch(board, await g.snapshot(board.repoRoot));
  return newBranch(board, parent.commit ?? null);
}

// ---- turns ----

export async function startTurn(boardId: string, parentId: string | null, prompt: string, position: Position, attachments: Attachment[] = []): Promise<TurnNode> {
  const board = getBoard(boardId);
  if (!board) throw new Error('Board not found');
  const parent = parentId ? getTurn(parentId) : null;
  if (parentId && !parent) throw new Error('Parent turn not found');
  if (parent && (parent.status === 'running' || parent.status === 'waiting'))
    throw new Error('Wait for that turn to finish (or stop it) before replying.');
  if (parent && !parent.sessionId) throw new Error('That turn never started a session, so it cannot be continued.');

  const branch = await pickBranch(board, parent ?? null);
  const node: TurnNode = {
    kind: 'turn',
    id: nanoid(10),
    boardId,
    parentId,
    branchId: branch.id,
    prompt,
    ...(attachments.length ? { attachments } : {}),
    events: [],
    status: 'running',
    position,
    createdAt: Date.now(),
  };
  state.nodes.push(node);
  branch.headNodeId = node.id;
  emit({ type: 'branch', branch });
  touch(node);

  run(board, branch, node, parent ?? null).catch((err) => {
    node.status = 'error';
    node.error = String(err?.message ?? err);
    touch(node);
  });
  return node;
}

/**
 * Record what a step changed. Separate copy per branch: a commit, as you, with a real message
 * (skipped when nothing changed). Your own folder: a hidden snapshot, so nothing lands on your branch.
 */
export async function saveCheckpoint(board: Board, branch: Branch, node: TurnNode) {
  try {
    if (branch.worktree) {
      // If the folder moved to other code during the step (a checkout or pull), count only this
      // step's own work, not everything that landed on main in between.
      const head = await g.git(branch.worktree, 'rev-parse', 'HEAD');
      if (node.baseCommit) node.baseCommit = await g.stepBase(branch.worktree, node.baseCommit, node.baseCommit, head);
      const staged = await g.stageAll(branch.worktree);
      if (!staged.stat.trim()) {
        // Nothing left to save: no empty commit. (Commits the agent made itself still count.)
        node.commit = head;
        node.diffStat = node.baseCommit && node.baseCommit !== head ? await g.diffStat(branch.worktree, node.baseCommit, head) : { files: 0, insertions: 0, deletions: 0 };
        return;
      }
      const history: string[] = [];
      for (let p = node.parentId ? getTurn(node.parentId) : undefined; p && history.length < 6; p = p.parentId ? getTurn(p.parentId) : undefined) history.push(p.prompt);
      const userBranch = board.repoRoot ? await g.git(board.repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '') : '';
      const msg = await commitMessage({
        prompt: node.prompt,
        history,
        summary: lastAgentText(node),
        stat: staged.stat,
        patch: staged.patch,
        recent: await g.recentSubjects(branch.worktree),
        branchName: userBranch,
        cwd: branch.worktree,
      });
      node.commit = await g.checkpoint(branch.worktree, msg.subject, msg.body);
      node.commitMessage = msg.subject;
      if (node.baseCommit) node.diffStat = await g.diffStat(branch.worktree, node.baseCommit, node.commit);
    } else if (board.repoRoot && node.baseCommit) {
      const head = await g.git(branch.cwd, 'rev-parse', 'HEAD');
      node.baseCommit = await g.stepBase(branch.cwd, node.baseCommit, await g.startHeadOf(branch.cwd, node.baseCommit, true), head);
      node.commit = await g.snapshot(branch.cwd);
      node.diffStat = await g.diffStat(branch.cwd, node.baseCommit, node.commit);
    }
  } catch (err: any) {
    node.error = (node.error ? node.error + '\n' : '') + `Checkpoint failed: ${err?.message ?? err}`;
  }
}

async function run(board: Board, branch: Branch, node: TurnNode, parent: TurnNode | null) {
  const r: Running = { abort: new AbortController(), queue: [], showNext: () => {} };
  running.set(node.id, r);

  if (branch.worktree) node.baseCommit = await g.git(branch.worktree, 'rev-parse', 'HEAD');
  // Working in your own folder: remember how it looked (a hidden snapshot, your branch and index
  // are untouched) so this step's changes can be shown.
  else if (board.repoRoot) node.baseCommit = await g.snapshot(branch.cwd).catch(() => undefined);

  let promptText = node.prompt;
  if (parent?.sessionId) {
    ensureSessionAt(parent.sessionId, branch.cwd);
    const parentCwd = getBranch(parent.branchId)?.cwd;
    if (parentCwd && parentCwd !== branch.cwd)
      promptText =
        `[Forkspace: this conversation was forked into a separate copy of the project. ` +
        `Your working directory is now ${branch.cwd}. Earlier messages may mention ${parentCwd}; ` +
        `use the new path for all reads and edits.]\n\n${node.prompt}`;
  }

  // Attachments: small images go in as images; everything else as a path Claude reads.
  const inline: { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } }[] = [];
  const onDisk: string[] = [];
  for (const a of node.attachments ?? []) {
    const img = a.kind === 'image' ? imageBytes(a) : null;
    if (img && img.bytes.length <= INLINE_IMAGE_MAX) inline.push({ type: 'image', source: { type: 'base64', media_type: img.type as 'image/png', data: img.bytes.toString('base64') } });
    else {
      const f = attachmentPath(a);
      if (f) onDisk.push(f);
    }
  }
  if (onDisk.length) promptText += `\n\n[Attached ${onDisk.length === 1 ? 'file' : 'files'}, read with the Read tool:\n${onDisk.map((f) => `- ${f}`).join('\n')}]`;
  // Streamed input stays open until the answer arrives, so permission prompts keep working.
  let release = () => {};
  const finished = new Promise<void>((res) => (release = res));
  async function* withImages() {
    yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content: [...inline, { type: 'text' as const, text: promptText }] } };
    await finished;
  }

  r.showNext = () => {
    const next = r.queue[0];
    node.pending = next ? { requestId: next.requestId, toolName: next.toolName, input: next.input, canAlways: next.canAlways, safety: next.safety } : undefined;
    node.status = next ? 'waiting' : 'running';
    touch(node);
  };

  const canUseTool: CanUseTool = (toolName, input, { signal, suggestions }) =>
    new Promise<PermissionResult>((resolve) => {
      // Paused by a safety rule: say why, and offer no "Always" (each one gets its own yes).
      const safety = check(toolName, input)?.reason;
      const p: Pending = { requestId: nanoid(8), toolName, input, canAlways: !safety && !!suggestions?.length, suggestions, safety, resolve };
      r.queue.push(p);
      if (r.queue.length === 1) queueMicrotask(() => notifyFn(node, 'waiting'));
      signal.addEventListener('abort', () => answer(node.id, p.requestId, 'deny'));
      r.showNext();
    });

  const q = query({
    prompt: inline.length ? (withImages() as any) : promptText,
    options: {
      cwd: branch.cwd,
      ...(onDisk.length ? { additionalDirectories: [...new Set(onDisk.map((f) => path.dirname(f)))] } : {}),
      resume: parent?.sessionId,
      forkSession: !!parent?.sessionId,
      // Imported cards share one transcript; resume it exactly where this card ended.
      ...(parent?.resumeAt ? { resumeSessionAt: parent.resumeAt } : {}),
      abortController: r.abort,
      permissionMode: board.permissionMode,
      allowDangerouslySkipPermissions: board.permissionMode === 'bypassPermissions',
      canUseTool,
      includePartialMessages: true,
      // Forkspace's safety rules: told to the agent, and enforced before every tool, in every mode.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SAFETY_RULES },
      hooks: safetyHooks,
      model: board.model || undefined,
      ...(branch.worktree ? { projectConfigRoot: board.cwd } : {}),
    },
  });

  try {
    for await (const msg of q) {
      handle(node, msg as any);
      // The answer is in: close the image input so the run can end.
      if ((msg as any).type === 'result') release();
    }
    if (node.status !== 'error') node.status = r.abort.signal.aborted ? 'stopped' : 'done';
  } catch (err: any) {
    node.status = r.abort.signal.aborted ? 'stopped' : 'error';
    if (node.status === 'error') node.error = String(err?.message ?? err);
  } finally {
    release();
    running.delete(node.id);
    node.pending = undefined;
    node.events = node.events.filter((e) => !(e.t === 'text' && e.partial));
    node.finishedAt = Date.now();
    await saveCheckpoint(board, branch, node);
    touch(node);
    // The app changed: snap the preview so the step shows what it looks like now.
    const changedFiles = !!node.diffStat?.files || node.events.some((e) => e.t === 'tool' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.name));
    if (board.previewUrl && node.status === 'done' && changedFiles)
      capture(board.previewUrl).then(
        (id) => {
          node.shots = [...(node.shots ?? []), id].slice(-12);
          touch(node);
        },
        () => {},
      );
    // First step of a new thread: give the thread a short title, like Claude Code does.
    if (!node.parentId && !node.title && node.status === 'done')
      threadTitle(node.prompt, lastAgentText(node), branch.cwd).then((t) => {
        if (!node.title) {
          node.title = t;
          touch(node);
        }
      });
    if (node.status === 'done' || node.status === 'error') notifyFn(node, 'finished');
    if (node.status === 'done') activityFn(node, true);
  }
}

function clip(s: string, n = 6000) {
  return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : JSON.stringify(c))).join('\n');
  return JSON.stringify(content);
}

function handle(node: TurnNode, msg: any) {
  if (msg.session_id && !node.sessionId) node.sessionId = msg.session_id;
  // Subagent internals stay inside their tool call.
  if (msg.parent_tool_use_id) return;

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        node.sessionId = msg.session_id;
        touch(node);
      }
      return;
    case 'stream_event': {
      const ev = msg.event;
      if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        const last = node.events[node.events.length - 1];
        if (last?.t === 'text' && last.partial) last.text += ev.delta.text;
        else node.events.push({ t: 'text', text: ev.delta.text, partial: true });
        touch(node);
      }
      return;
    }
    case 'assistant': {
      node.events = node.events.filter((e) => !(e.t === 'text' && e.partial));
      for (const b of msg.message?.content ?? []) {
        let e: TurnEvent | null = null;
        if (b.type === 'text' && b.text) e = { t: 'text', text: b.text };
        else if (b.type === 'thinking' && b.thinking) e = { t: 'thinking', text: b.thinking };
        else if (b.type === 'tool_use') e = { t: 'tool', id: b.id, name: b.name, input: b.input };
        if (e) node.events.push(e);
      }
      touch(node);
      return;
    }
    case 'user': {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const ev = node.events.find((e) => e.t === 'tool' && e.id === b.tool_use_id);
        if (ev && ev.t === 'tool') {
          ev.result = clip(toolResultText(b.content));
          ev.isError = !!b.is_error;
        }
      }
      touch(node);
      activityFn(node);
      return;
    }
    case 'result':
      node.sessionId = msg.session_id ?? node.sessionId;
      node.costUsd = msg.total_cost_usd;
      node.durationMs = msg.duration_ms;
      if (msg.subtype !== 'success' || msg.is_error) {
        node.status = 'error';
        node.error = (msg.errors?.join('\n') || msg.result || msg.subtype || 'Agent error') as string;
      }
      touch(node);
      return;
  }
}

export function answer(nodeId: string, requestId: string, decision: 'allow' | 'always' | 'deny', answers?: Record<string, string>, message?: string) {
  const r = running.get(nodeId);
  if (!r) return;
  const i = r.queue.findIndex((p) => p.requestId === requestId);
  if (i < 0) return;
  const [p] = r.queue.splice(i, 1);
  if (decision !== 'allow' && decision !== 'always') p.resolve({ behavior: 'deny', message: message || 'The user denied this action.' });
  else
    p.resolve({
      behavior: 'allow',
      updatedInput: answers ? { ...p.input, answers } : p.input,
      ...(decision === 'always' && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
    });
  r.showNext();
}

export function stop(nodeId: string) {
  const r = running.get(nodeId);
  if (!r) return;
  for (const p of [...r.queue]) answer(nodeId, p.requestId, 'deny');
  r.abort.abort();
}

export const isRunning = (nodeId: string) => running.has(nodeId);

/** Remove worktrees for branches that no longer have any turns. */
let pruning: Promise<void> = Promise.resolve();
/** One prune at a time: two at once could each remove the other's branches. */
export function pruneBranches() {
  pruning = pruning.then(prune, prune);
  return pruning;
}
async function prune() {
  const used = new Set(state.nodes.flatMap((n) => (n.kind === 'turn' ? [n.branchId] : [])));
  for (const b of [...state.branches]) {
    if (used.has(b.id)) continue;
    const i = state.branches.indexOf(b);
    if (i < 0) continue;
    state.branches.splice(i, 1);
    const board = getBoard(b.boardId);
    if (b.worktree && board?.repoRoot) await g.removeWorktree(board.repoRoot, b.worktree, b.gitBranch).catch(() => {});
  }
  save();
}

/** The agent's last words in a step: its own summary of what it did. */
function lastAgentText(node: TurnNode) {
  for (let i = node.events.length - 1; i >= 0; i--) {
    const e = node.events[i];
    if (e.t === 'text' && !e.partial && e.text.trim()) return e.text;
  }
  return '';
}
