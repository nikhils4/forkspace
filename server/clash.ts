import path from 'node:path';
import type { Board, Branch, Overlap, TurnNode } from '../shared/types.ts';
import * as g from './git.ts';
import { getBoard, getTurn, save, state } from './store.ts';

// Clash warning: two agents changing the same files. Caught while they work, not at merge time.
//   - Separate copies (worktrees): compare what each thread changed since their histories split,
//     committed checkpoints and unsaved work alike. A fork never clashes with work it inherited.
//   - Same folder: compare the files each working agent is editing right now.
// Only threads still in play count: something working, or finished in the last two days and not
// marked completed.

const RECENT = 48 * 3600_000;
const MAX_FILES = 30;
// Regenerated, not hand-merged: two threads touching these isn't worth a warning.
const IGNORE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock)$/;

type Emit = (b: Branch) => void;
let emit: Emit = () => {};
export const setClashEmitter = (fn: Emit) => (emit = fn);

const isLive = (n: TurnNode) => n.status === 'running' || n.status === 'waiting';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface Side {
  branch: Branch;
  turns: TurnNode[];
  live: boolean;
  /** Worktree head commit (separate copies only). */
  head?: string;
}

function candidates(board: Board): Side[] {
  const out: Side[] = [];
  const now = Date.now();
  for (const branch of state.branches) {
    if (branch.boardId !== board.id) continue;
    const turns = state.nodes.filter((n): n is TurnNode => n.kind === 'turn' && n.branchId === branch.id);
    const head = branch.headNodeId ? getTurn(branch.headNodeId) : undefined;
    if (!head || head.completed) continue;
    const live = turns.some(isLive);
    if (!live && now - (head.finishedAt ?? head.createdAt) > RECENT) continue;
    out.push({ branch, turns, live });
  }
  return out;
}

/** Files the working steps on this thread are editing, relative to the repo (or board) root. */
function editing(board: Board, side: Side): Set<string> {
  const root = board.repoRoot ?? board.cwd;
  const out = new Set<string>();
  for (const t of side.turns) {
    if (!isLive(t)) continue;
    for (const e of t.events) {
      if (e.t !== 'tool' || !EDIT_TOOLS.has(e.name)) continue;
      const f = String((e.input as any)?.file_path ?? (e.input as any)?.notebook_path ?? '');
      if (!f) continue;
      const rel = path.relative(root, path.resolve(side.branch.cwd, f));
      if (!rel.startsWith('..')) out.add(rel);
    }
  }
  return out;
}

/** Everything a separate copy changed since `base`: commits plus unsaved and brand-new files. */
async function changedSince(wt: string, base: string): Promise<Set<string>> {
  const [tracked, untracked] = await Promise.all([
    g.git(wt, '-c', 'core.quotepath=off', 'diff', '--name-only', base).catch(() => ''),
    g.git(wt, '-c', 'core.quotepath=off', 'ls-files', '-o', '--exclude-standard').catch(() => ''),
  ]);
  return new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean));
}

/** The commit this thread's own work started from (where it forked off, not the thread's root). */
function ownBase(side: Side) {
  const first = side.turns.reduce<TurnNode | undefined>((a, b) => (!a || b.createdAt < a.createdAt ? b : a), undefined);
  return first?.baseCommit;
}

async function filesFor(board: Board, a: Side, other: Side, cache: Map<string, Set<string>>): Promise<Set<string>> {
  if (!a.branch.worktree) return editing(board, a);
  // Against another separate copy: only what changed since the two split.
  let base = ownBase(a);
  if (other.branch.worktree && a.head && other.head) base = (await g.git(board.repoRoot!, 'merge-base', a.head, other.head).catch(() => '')) || base;
  if (!base) return new Set();
  const key = `${a.branch.id}:${base}`;
  if (!cache.has(key)) cache.set(key, await changedSince(a.branch.worktree, base));
  return cache.get(key)!;
}

async function scanBoard(board: Board) {
  const sides = candidates(board);
  for (const s of sides) if (s.branch.worktree) s.head = await g.git(s.branch.worktree, 'rev-parse', 'HEAD').catch(() => undefined);
  const found = new Map<string, Overlap[]>();
  const cache = new Map<string, Set<string>>();
  for (let i = 0; i < sides.length; i++)
    for (let j = i + 1; j < sides.length; j++) {
      const a = sides[i];
      const b = sides[j];
      // Same folder, neither working: nothing can collide any more.
      if ((!a.branch.worktree || !b.branch.worktree) && !(a.live && b.live)) continue;
      const fa = await filesFor(board, a, b, cache);
      if (!fa.size) continue;
      const fb = await filesFor(board, b, a, cache);
      const shared = [...fa].filter((f) => fb.has(f) && !IGNORE.test(f)).sort();
      if (!shared.length) continue;
      const kind = a.branch.worktree && b.branch.worktree ? 'copies' : 'folder';
      const entry = (other: Side): Overlap => ({ branchId: other.branch.id, files: shared.slice(0, MAX_FILES), count: shared.length, kind });
      found.set(a.branch.id, [...(found.get(a.branch.id) ?? []), entry(b)]);
      found.set(b.branch.id, [...(found.get(b.branch.id) ?? []), entry(a)]);
    }
  let changed = false;
  for (const branch of state.branches) {
    if (branch.boardId !== board.id) continue;
    const next = found.get(branch.id);
    if (JSON.stringify(next ?? null) === JSON.stringify(branch.overlaps ?? null)) continue;
    if (next) branch.overlaps = next;
    else delete branch.overlaps;
    changed = true;
    emit(branch);
  }
  if (changed) save();
}

// What each board looked like at its last scan: idle boards that haven't changed are skipped.
const lastSig = new Map<string, string>();
let scanning = false;

export async function scanClashes(force = false) {
  if (scanning) return;
  scanning = true;
  try {
    for (const board of state.boards) {
      const turns = state.nodes.filter((n): n is TurnNode => n.kind === 'turn' && n.boardId === board.id);
      const live = turns.some(isLive);
      const sig = turns.map((t) => `${t.id}:${t.status}:${t.commit ?? ''}:${t.completed ? 1 : 0}`).join('|') + state.branches.filter((b) => b.boardId === board.id).map((b) => b.headNodeId).join(',');
      if (!force && !live && lastSig.get(board.id) === sig) continue;
      lastSig.set(board.id, sig);
      if (!getBoard(board.id)) continue;
      await scanBoard(board).catch(() => {});
    }
  } finally {
    scanning = false;
  }
}

export function startClashWatch() {
  setTimeout(() => scanClashes(true), 3000).unref?.();
  setInterval(() => scanClashes(), 6000).unref?.();
}
