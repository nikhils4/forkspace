import type { Board, Branch, CanvasNode, PrInfo, TurnNode } from '../shared/types.ts';
import { placement } from './layout.ts';
import { request, send, toast } from './store.ts';
import { isLive, isTurn, lastText, currentActivity } from './tree.ts';

// One status for every branch and thread, so the sidebar, the Work page, the details panel and
// the canvas all say the same thing: what needs you, what's working, what GitHub says.

export type Stage = 'needs' | 'error' | 'failing' | 'feedback' | 'working' | 'checking' | 'ready' | 'review' | 'idle' | 'merged' | 'done';

/** Most urgent first. */
export const STAGES: Stage[] = ['needs', 'error', 'failing', 'feedback', 'working', 'checking', 'ready', 'review', 'idle', 'merged', 'done'];

export const STAGE_LABEL: Record<Stage, string> = {
  needs: 'Needs you',
  error: 'Failed',
  failing: 'Checks failing',
  feedback: 'Has comments',
  working: 'Working',
  checking: 'Checks running',
  ready: 'Ready to merge',
  review: 'Ready for review',
  idle: 'Idle',
  merged: 'Merged',
  done: 'Done',
};

/** What GitHub says, as a stage (undefined when there's no open PR to talk about). */
export function prStage(pr?: PrInfo): Stage | undefined {
  if (!pr?.state) return undefined;
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'done';
  if ((pr.checks?.failing ?? 0) > 0 || pr.conflicts) return 'failing';
  if ((pr.bugs ?? 0) + (pr.comments ?? 0) > 0 || pr.changesRequested) return 'feedback';
  if ((pr.checks?.pending ?? 0) > 0) return 'checking';
  return pr.draft ? 'review' : 'ready';
}

export const turnsOfBranch = (nodes: Record<string, CanvasNode>, branchId: string) =>
  Object.values(nodes)
    .filter((n): n is TurnNode => isTurn(n) && n.branchId === branchId)
    .sort((a, b) => a.createdAt - b.createdAt);

const at = (t: TurnNode) => t.finishedAt ?? t.createdAt;

/** A branch's stage: the agent first (it needs you, it's working, it failed), then its PR. */
export function branchStage(turns: TurnNode[], branch: Branch | undefined, ready: Set<string>, completed = false): Stage {
  if (turns.some((t) => t.status === 'waiting')) return 'needs';
  if (turns.some((t) => t.status === 'running')) return 'working';
  const last = turns[turns.length - 1];
  const pr = prStage(branch?.pr);
  if (pr && pr !== 'review') return pr;
  if (last?.status === 'error') return 'error';
  if (completed) return 'done';
  if (pr) return pr;
  // Finished and already looked at, but not marked complete: still yours, just quiet.
  return turns.some((t) => ready.has(t.id)) ? 'review' : 'idle';
}

export const worst = (stages: Stage[]): Stage => stages.reduce((a, b) => (STAGES.indexOf(b) < STAGES.indexOf(a) ? b : a), 'done' as Stage);

export interface BranchRow {
  branch: Branch | undefined;
  branchId: string;
  label: string;
  stage: Stage;
  /** The card to jump to: the branch's latest step. */
  last: TurnNode;
  at: number;
  steps: number;
}
/** A task is called by the start of what you asked, unless you renamed it. */
export const taskName = (root: TurnNode) => (root.named && root.title ? root.title : (root.prompt || root.title || 'Task').replace(/\s+/g, ' ').trim());

export interface ThreadRow {
  root: TurnNode;
  board: Board | undefined;
  title: string;
  stage: Stage;
  at: number;
  branches: BranchRow[];
  /** One line on what's happening or what it said last. */
  now: string;
}

/** Every thread on a board (or on all boards), with its branches, newest activity first. */
export function threadsOf(nodes: Record<string, CanvasNode>, branches: Record<string, Branch>, boards: Board[], ready: Set<string>, boardId?: string): ThreadRow[] {
  const turns = Object.values(nodes).filter((n): n is TurnNode => isTurn(n) && (!boardId || n.boardId === boardId));
  const kids = new Map<string, TurnNode[]>();
  for (const t of turns) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
  const out: ThreadRow[] = [];
  for (const root of turns.filter((t) => !t.parentId)) {
    // Every step under this root, grouped by branch.
    const all: TurnNode[] = [];
    const stack = [root];
    while (stack.length) {
      const t = stack.pop()!;
      all.push(t);
      stack.push(...(kids.get(t.id) ?? []));
    }
    const byBranch = new Map<string, TurnNode[]>();
    for (const t of all) byBranch.set(t.branchId, [...(byBranch.get(t.branchId) ?? []), t]);
    const rows: BranchRow[] = [...byBranch.entries()].map(([branchId, list]) => {
      list.sort((a, b) => a.createdAt - b.createdAt);
      const first = list[0];
      const last = list[list.length - 1];
      return {
        branch: branches[branchId],
        branchId,
        label: branchId === root.branchId ? 'Main line' : first.title || first.prompt,
        stage: branchStage(list, branches[branchId], ready, root.completed),
        last,
        at: Math.max(...list.map(at)),
        steps: list.length,
      };
    });
    // The thread's own line first, then forks newest first.
    rows.sort((a, b) => (a.branchId === root.branchId ? -1 : b.branchId === root.branchId ? 1 : b.at - a.at));
    const live = all.filter(isLive).sort((a, b) => b.createdAt - a.createdAt)[0];
    const latest = all.reduce((a, b) => (at(b) > at(a) ? b : a), root);
    out.push({
      root,
      board: boards.find((b) => b.id === root.boardId),
      title: taskName(root),
      stage: worst(rows.map((r) => r.stage)),
      at: Math.max(...rows.map((r) => r.at)),
      branches: rows,
      now: live ? currentActivity(live) : lastText(latest) || latest.error || '',
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The prompt that hands everything still open on a PR back to the agent. */
export function fixPrompt(pr: PrInfo) {
  const lines = (pr.items ?? []).map((it, i) => {
    const where = it.path ? ` in \`${it.path}${it.line ? `:${it.line}` : ''}\`` : '';
    switch (it.kind) {
      case 'check':
        return `${i + 1}. Failing check "${it.title}"${it.url ? ` (${it.url})` : ''}. Read its logs (gh run view --log-failed) and fix the cause.`;
      case 'conflict':
        return `${i + 1}. The PR has merge conflicts. Merge the base branch in and resolve them.`;
      case 'changes':
        return `${i + 1}. A reviewer requested changes. Address the review comments below.`;
      default:
        return `${i + 1}. ${it.kind === 'bug' ? 'Bug report' : 'Review comment'}${it.who ? ` from ${it.who}` : ''}${where}:\n${(it.body || it.title).split('\n').map((l) => `   ${l}`).join('\n')}`;
    }
  });
  return (
    `Pull request ${pr.url} still has open items. Work through each one: fix it, or say why it should stay as is. ` +
    `Then commit, push to the same branch, and reply with what you changed for each item.\n\n${lines.join('\n\n')}`
  );
}

/** Send "Fix these" as the next step on the branch. */
export async function sendFix(nodes: Record<string, CanvasNode>, last: TurnNode, pr: PrInfo) {
  const { position, moves } = placement(nodes, last.boardId, last.id, { x: last.position.x, y: last.position.y + 320 });
  try {
    if (moves.length) send({ type: 'move', moves });
    const r = await request<{ id: string; queued?: boolean }>({ type: 'send', boardId: last.boardId, parentId: last.id, prompt: fixPrompt(pr), position });
    toast(r.queued ? 'Queued: the agent works on the PR items next.' : 'Sent the PR items to the agent.');
    return r;
  } catch (e: any) {
    toast(e.message, 'error');
  }
}
