import { nanoid } from 'nanoid';
import type { Branch, ConceptDoc, ServerMsg, ThreadNote, TurnNode } from '../shared/types.ts';
import { readOnly } from './codemap.ts';
import * as g from './git.ts';
import { getBoard, getBranch, save, state } from './store.ts';
import { describe } from './tutor.ts';

// Each thread keeps one living note: what it's for, what changed, how it works (with links to
// the code and every decision spelled out), what was decided and what's still open. Claude
// rewrites it after every step. When the thread is deleted, the note moves to Concepts.

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

/** A step finished: fold it into its thread's note. */
export function noteAfterStep(node: TurnNode) {
  const board = getBoard(node.boardId);
  if (!board || board.learn?.on === false) return;
  void update(node.branchId, false);
}

/** Rewrite a thread's note now, even if nothing new happened. */
export function refreshNote(branchId: string) {
  return update(branchId, true);
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
  const turns = turnsOf(branchId).filter(isDone);
  const folded = force ? 0 : (branch.note?.steps ?? 0);
  const fresh = turns.slice(folded);
  if (!turns.length || (!fresh.length && !force)) return;

  const before = earlier(turnsOf(branchId)[0]);
  const parentNote = before.length ? state.branches.find((b) => b.id === before.at(-1)!.branchId)?.note : undefined;
  const prev = force ? undefined : (branch.note?.markdown ?? parentNote?.markdown);

  branch.note = { ...(branch.note ?? { title: '', markdown: '', updatedAt: 0, steps: 0 }), busy: true, error: undefined };
  pushBranch(branch);

  try {
    const steps: string[] = [];
    let budget = 26_000;
    for (const t of fresh) {
      const diff = await stepDiff(branch.cwd, t);
      const part = [`### Step: "${clip(t.prompt, 1200)}"`, `What the agent did:\n${clip(describe(t.events, branch), 9000)}`, diff].filter(Boolean).join('\n\n');
      steps.push(clip(part, Math.max(3000, budget)));
      budget -= part.length;
    }
    const context = !prev && before.length ? `Earlier in this thread (before this branch started):\n${before.map((t) => `- Asked: "${clip(t.prompt, 300)}". Result: ${clip(lastWords(t), 400)}`).join('\n')}\n\n` : '';
    const prompt =
      (prev ? `The note so far:\n\n${prev}\n\n---\n\nFold in what happened since:\n\n` : `${context}Write the note for this thread from what happened:\n\n`) +
      steps.join('\n\n') +
      `\n\nRead the code where you need to, to be exact about how it works. Then write the whole note, in this shape:\n` +
      `# <the title>\n` +
      `One or two sentences: what this thread is for (the feature, the bug, the change) and where it stands now.\n` +
      `## What changed\n` +
      `Every change made so far, grouped by area. For each: what and why, with \`path:line\` links.\n` +
      `## How it works\n` +
      `The flow in full detail, as numbered steps: what starts it, what calls what, where data goes and how it changes, with \`path:line\` for each step. ` +
      `Spell out every decision on the way as its own line: "If …: …", including errors, limits and special cases. Use a short realistic example if it helps.\n` +
      `## Decisions and discussion\n` +
      `What the developer asked for, what was decided and why, options turned down. Skip if nothing.\n` +
      `## Still open\n` +
      `Follow-ups, known gaps, risks. Skip if nothing.\n\n` +
      (prev ? `Keep everything from the note that is still true, update what changed, and remove what was undone. ` : '') +
      `Leave out anything that didn't happen. Questions without code changes still count: note what was learned.`;
    const res = await readOnly<{ title: string; markdown: string }>(prompt, SYSTEM, SCHEMA, branch.cwd, () => {}, 14, MODEL);
    const note: ThreadNote = { title: res.title.trim() || 'Thread notes', markdown: res.markdown.trim(), updatedAt: Date.now(), steps: turns.length };
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
  const branch = getBranch(branchId);
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
