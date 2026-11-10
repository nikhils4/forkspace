import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Board, Branch, CanvasNode, State, TurnNode } from '../shared/types.ts';

export const HOME = process.env.FORKSPACE_HOME || path.join(os.homedir(), '.forkspace');
const FILE = path.join(HOME, 'state.json');

fs.mkdirSync(HOME, { recursive: true });

function load(): State {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8')) as State;
    // Anything that was mid-run when the server stopped can't be resumed mid-turn.
    for (const n of s.nodes) {
      if (n.kind === 'turn') n.learning = false;
      if (n.kind === 'turn' && (n.status === 'running' || n.status === 'waiting')) {
        n.status = 'stopped';
        n.pending = undefined;
        n.learning = false;
        n.events = n.events.filter((e) => !(e.t === 'text' && e.partial));
      }
    }
    if (!Array.isArray(s.boards) || !Array.isArray(s.branches) || !Array.isArray(s.nodes)) throw new Error('state file is missing data');
    for (const b of s.boards) if (!Array.isArray(b.links)) b.links = [];
    return s;
  } catch (err: any) {
    if (err?.code !== 'ENOENT' && fs.existsSync(FILE)) {
      // Keep the broken file for recovery instead of overwriting it with an empty workspace.
      const keep = `${FILE}.broken-${Date.now()}`;
      try {
        fs.renameSync(FILE, keep);
      } catch {}
      console.error(`\n  Forkspace could not read ${FILE} (${err?.message}). It was kept as ${keep}. Starting with an empty workspace.\n`);
    }
    return { boards: [], branches: [], nodes: [] };
  }
}

export const state: State = load();

let timer: NodeJS.Timeout | null = null;
export function save() {
  if (timer) return;
  timer = setTimeout(flush, 300);
}

export function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, FILE);
}

export const getBoard = (id: string): Board | undefined => state.boards.find((b) => b.id === id);
export const getBranch = (id: string): Branch | undefined => state.branches.find((b) => b.id === id);
export const getNode = (id: string): CanvasNode | undefined => state.nodes.find((n) => n.id === id);
export function getTurn(id: string): TurnNode | undefined {
  const n = getNode(id);
  return n?.kind === 'turn' ? n : undefined;
}

/** The node and every descendant turn. */
export function subtree(id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const n of state.nodes) if (n.kind === 'turn' && n.parentId === out[i]) out.push(n.id);
  }
  return out;
}
