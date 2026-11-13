import { nanoid } from 'nanoid';
import type { Branch, ConceptDoc, ServerMsg, ThreadNote, TurnNode } from '../shared/types.ts';
import { readOnly } from './codemap.ts';
import * as g from './git.ts';
import { getBoard, getBranch, save, state } from './store.ts';
import { describe } from './tutor.ts';

// Each thread keeps one living note, status first: where it stands and what's next, then a table
// of the work and its state, what changed, how it works (with links to the code), what was decided
// and what's open. Claude rewrites it after every step. When the thread is deleted, the note moves
// to Concepts.

const MODEL = process.env.FORKSPACE_NOTES_MODEL || 'sonnet';

let emit: (m: ServerMsg) => void = () => {};
export const setNotesEmit = (fn: (m: ServerMsg) => void) => (emit = fn);
const pushBranch = (b: Branch) => emit({ type: 'branch', branch: b });
const pushConcepts = () => emit({ type: 'concepts', concepts: state.concepts ?? [] });

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'What this thread is about, in 3 to 8 plain words, like "Hold stock during checkout".' },
    markdown: { type: 'string', description: 'The whole note, in markdown, following the sections asked for.' },
  },
  required: ['title', 'markdown'],
};

const SYSTEM =
  'You keep the working notes for a thread of coding work, for the developer who owns it. ' +
  'Write like a sharp senior engineer explaining to a teammate: plain words, short sentences, no filler, no jargon without a few words saying what it means. ' +
  'Be exact and complete: real file paths and lines, real names, real numbers. Only write what is true in the code and the activity. ' +
  'Refer to code as `path/to/file.ts:42` in backticks so it becomes a link.';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} …` : s);
const turnsOf = (branchId: string) =>
  state.nodes.filter((n): n is TurnNode => n.kind === 'turn' && n.branchId === branchId).sort((a, b) => a.createdAt - b.createdAt);
const isDone = (t: TurnNode) => t.status !== 'running' && t.status !== 'waiting';
const lastWords = (t: TurnNode) => {
  for (let i = t.events.length - 1; i >= 0; i--) {
    const e = t.events[i];
    if (e.t === 'text' && !e.partial && e.text.trim()) return e.text;
  }
  return '';
};

const turnById = (id?: string | null) => (id ? state.nodes.find((n): n is TurnNode => n.kind === 'turn' && n.id === id) : undefined);

/** The thread a branch belongs to: its note lives on the branch of the thread's first card. */
export function threadBranchId(branchId: string): string {
  let t = turnsOf(branchId)[0];
  for (let p = turnById(t?.parentId); p; p = turnById(p.parentId)) t = p;
  return t?.branchId ?? branchId;
}

/** Every step in a thread, across all its branches, oldest first. */
function threadTurns(rootBranchId: string): TurnNode[] {
  const root = turnsOf(rootBranchId).find((t) => !turnById(t.parentId));
  if (!root) return turnsOf(rootBranchId);
  const kids = new Map<string, TurnNode[]>();
  for (const n of state.nodes) if (n.kind === 'turn' && n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n as TurnNode]);
  const out: TurnNode[] = [];
  const walk = (t: TurnNode) => {
    out.push(t);
    for (const k of kids.get(t.id) ?? []) walk(k);
  };
  walk(root);
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** Steps before this branch started (a branch made from the middle of another thread). */
function earlier(first: TurnNode | undefined) {
  const out: TurnNode[] = [];
  const find = (id?: string | null) => (id ? state.nodes.find((n): n is TurnNode => n.kind === 'turn' && n.id === id) : undefined);
  let cur = find(first?.parentId);
  while (cur) {
    out.unshift(cur);
    cur = find(cur.parentId);
  }
  return out;
}

async function stepDiff(cwd: string, t: TurnNode) {
  if (!t.baseCommit || !t.commit) return '';
  const stat = await g.git(cwd, 'diff', '--stat', t.baseCommit, t.commit).catch(() => '');
  const patch = await g.git(cwd, 'diff', '--no-color', '-U2', t.baseCommit, t.commit).catch(() => '');
  return stat ? `Files changed:\n${stat}\n\nThe change:\n${clip(patch, 9000)}` : '';
}

const running = new Map<string, { pending: boolean }>();

/** A step finished (done, stopped or failed): fold it into its thread's note. */
export function noteAfterStep(node: TurnNode) {
  const board = getBoard(node.boardId);
  if (!board || board.learn?.on === false) return;
  void update(threadBranchId(node.branchId), false);
}

/** Bring a thread's note up to date now: 'sync' folds in what's missing, 'rewrite' starts over. */
export function refreshNote(branchId: string, mode: 'sync' | 'rewrite' = 'rewrite') {
  return update(threadBranchId(branchId), mode === 'rewrite');
}

async function update(branchId: string, force: boolean): Promise<void> {
  const r = running.get(branchId);
  if (r) {
    r.pending = true;
    return;
  }
  const run = { pending: false };
  running.set(branchId, run);
  try {
    await write(branchId, force);
  } finally {
    running.delete(branchId);
    if (run.pending) void update(branchId, false);
  }
}

async function write(branchId: string, force: boolean) {
  const branch = getBranch(branchId);
  const board = branch && getBoard(branch.boardId);
  if (!branch || !board) return;
  const turns = threadTurns(branchId).filter(isDone);
  // Which steps are already in the note. Older notes only kept a count of this branch's steps.
  const had = branch.note?.stepIds ?? turnsOf(branchId).filter(isDone).slice(0, branch.note?.steps ?? 0).map((t) => t.id);
  const folded = new Set(force ? [] : had);
  const fresh = turns.filter((t) => !folded.has(t.id));
  if (!turns.length || (!fresh.length && !force)) return;

  const before = earlier(turnsOf(branchId)[0]);
  const parentNote = before.length ? state.branches.find((b) => b.id === before.at(-1)!.branchId)?.note : undefined;
  const prev = force ? undefined : (branch.note?.markdown || parentNote?.markdown);
  // Where each step sits: the main line, or a branch tried from an earlier step.
  const where = (t: TurnNode) => {
    if (t.branchId === branchId) return 'main line';
    const first = turnsOf(t.branchId)[0];
    const from = turnById(first?.parentId);
    return `branch "${clip(first?.prompt ?? '', 60)}"${from ? `, tried from the step "${clip(from.prompt, 60)}"` : ''}`;
  };
  const branched = turns.some((t) => t.branchId !== branchId);

  branch.note = { ...(branch.note ?? { title: '', markdown: '', updatedAt: 0, steps: 0 }), busy: true, error: undefined };
  pushBranch(branch);

  try {
    const steps: string[] = [];
    let budget = 26_000;
    for (const t of fresh) {
      const diff = await stepDiff((getBranch(t.branchId) ?? branch).cwd, t);
      const stepBranch = getBranch(t.branchId) ?? branch;
      const status = t.status === 'done' ? '' : ` (${t.status === 'error' ? 'failed' : t.status})`;
      const part = [`### Step${status} on the ${where(t)}: "${clip(t.prompt, 1200)}"`, `What the agent did:\n${clip(describe(t.events, stepBranch), 9000)}`, diff].filter(Boolean).join('\n\n');
      steps.push(clip(part, Math.max(3000, budget)));
      budget -= part.length;
    }
    const context = !prev && before.length ? `Earlier in this thread (before this branch started):\n${before.map((t) => `- Asked: "${clip(t.prompt, 300)}". Result: ${clip(lastWords(t), 400)}`).join('\n')}\n\n` : '';
    const prompt =
      (prev ? `The note so far:\n\n${prev}\n\n---\n\nFold in what happened since:\n\n` : `${context}Write the note for this thread from what happened:\n\n`) +
      steps.join('\n\n') +
      `\n\nRead the code where you need to, to be exact about how it works. Then write the whole note, in exactly this shape. ` +
      `It's read by someone picking the thread back up: where things stand comes first, detail after.\n\n` +
      `# <the title>\n` +
      `**Now:** one line: where the thread stands right now.\n` +
      `**Next:** one line: the next concrete thing to do. Leave this line out when nothing is left.\n` +
      `## Work\n` +
      `A table of every piece of work in the thread (features, fixes, tickets, tries), one row each:\n` +
      `| Item | What | State |\n|---|---|---|\n` +
      `Item is a short name, keeping any ticket id. What is a few words. State is one of: done, in progress, planned, open, dropped, failed.` +
      (branched ? ` Add the branch to What when the work happened on a branch.` : '') +
      ` Skip this section when the thread is one single piece of work.\n` +
      `## What changed\n` +
      `Bullets, grouped by area: what changed and why, with \`path:line\`. Skip this section when no code changed.\n` +
      `## How it works\n` +
      `Short bullets in the order things happen, each with its \`path:line\`. Special cases and errors as sub-bullets: "If …: …". ` +
      `One short realistic example at the end if it helps. Keep it tight: the key steps, not every line.\n` +
      (branched
        ? `## Branches\n` +
          `One bullet per branch: what it tried, and where it stands. Keep "What changed" and "How it works" about the main line unless a branch replaced it.\n`
        : '') +
      `## Decided\n` +
      `Bullets as "Choice: why". Include options turned down. Skip if nothing.\n` +
      `## Open\n` +
      `Questions, risks, things to check. Skip if nothing.\n\n` +
      `Rules: leave out any section with nothing in it (never write "Nothing" or "None"). Write about the work, not about yourself or these notes: ` +
      `no "I", no "my record", no "cut off". Short bullets over paragraphs. ` +
      (prev ? `Rewrite the note so far into this shape even if it used another one. Keep everything still true, update what changed, remove what was undone. ` : '') +
      `Leave out anything that didn't happen. Questions without code changes still count: note what was learned.`;
    const res = await readOnly<{ title: string; markdown: string }>(prompt, SYSTEM, SCHEMA, branch.cwd, () => {}, 14, MODEL);
    const ids = [...new Set([...(force ? [] : had), ...fresh.map((t) => t.id)])].filter((id) => turns.some((t) => t.id === id));
    const note: ThreadNote = { title: res.title.trim() || 'Thread notes', markdown: res.markdown.trim(), updatedAt: Date.now(), steps: ids.length, stepIds: ids };
    const now = getBranch(branchId);
    if (!now) {
      // Deleted while writing: the note still goes to Concepts.
      keepDoc({ ...branch, note }, board.name);
      return;
    }
    now.note = note;
    // Already kept in Concepts: keep that copy current too.
    if (state.concepts?.some((c) => c.branchId === branchId)) keepDoc(now, board.name);
  } catch (err) {
    const now = getBranch(branchId);
    if (now?.note) now.note = { ...now.note, busy: false, error: (err as Error).message };
  } finally {
    const now = getBranch(branchId);
    if (now?.note) {
      now.note.busy = false;
      pushBranch(now);
    }
    save();
  }
}

function keepDoc(branch: Branch, boardName: string): ConceptDoc | null {
  const n = branch.note;
  if (!n?.markdown) return null;
  state.concepts ??= [];
  const had = state.concepts.find((c) => c.branchId === branch.id);
  const doc: ConceptDoc = { id: had?.id ?? nanoid(10), boardId: branch.boardId, boardName, branchId: branch.id, title: n.title, markdown: n.markdown, steps: n.steps, createdAt: had?.createdAt ?? Date.now(), at: Date.now() };
  state.concepts = [doc, ...state.concepts.filter((c) => c !== had)];
  save();
  pushConcepts();
  return doc;
}

/** Keep a thread's note in Concepts now (it stays in sync while the thread lives). */
export function keepNote(branchId: string) {
  const branch = getBranch(threadBranchId(branchId));
  if (!branch) throw new Error('Thread not found');
  if (!branch.note?.markdown) throw new Error('This thread has no notes yet.');
  return keepDoc(branch, getBoard(branch.boardId)?.name ?? '');
}

/** A thread is going away: its note moves to Concepts. */
export function archiveNote(branch: Branch) {
  keepDoc(branch, getBoard(branch.boardId)?.name ?? '');
}

export function deleteConcept(id: string) {
  state.concepts = (state.concepts ?? []).filter((c) => c.id !== id);
  save();
  pushConcepts();
}
