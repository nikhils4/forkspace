import type { CanvasNode, TurnNode } from '../shared/types.ts';

export const isTurn = (n: CanvasNode | undefined): n is TurnNode => n?.kind === 'turn';
export const isLive = (t: TurnNode) => t.status === 'running' || t.status === 'waiting';

export function turnsOf(nodes: Record<string, CanvasNode>, boardId: string) {
  return Object.values(nodes).filter((n): n is TurnNode => n.kind === 'turn' && n.boardId === boardId);
}

export function childrenOf(nodes: Record<string, CanvasNode>, id: string) {
  return Object.values(nodes)
    .filter((n): n is TurnNode => n.kind === 'turn' && n.parentId === id)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Root → node. */
export function pathTo(nodes: Record<string, CanvasNode>, id: string): TurnNode[] {
  const out: TurnNode[] = [];
  let cur: CanvasNode | undefined = nodes[id];
  while (isTurn(cur)) {
    out.unshift(cur);
    cur = cur.parentId ? nodes[cur.parentId] : undefined;
  }
  return out;
}

/** Most recently active leaf under a node (follow it to see where that branch ended up). */
export function latestLeaf(nodes: Record<string, CanvasNode>, id: string): TurnNode {
  let cur = nodes[id] as TurnNode;
  for (;;) {
    const kids = childrenOf(nodes, cur.id);
    if (!kids.length) return cur;
    cur = kids.reduce((a, b) => (activity(nodes, b.id) > activity(nodes, a.id) ? b : a));
  }
}

function activity(nodes: Record<string, CanvasNode>, id: string): number {
  const n = nodes[id] as TurnNode;
  let t = n.finishedAt ?? n.createdAt;
  for (const k of childrenOf(nodes, id)) t = Math.max(t, activity(nodes, k.id));
  return t;
}

/** Every branch tip on a board, newest first. */
export function leaves(nodes: Record<string, CanvasNode>, boardId: string) {
  const turns = turnsOf(nodes, boardId);
  const hasKid = new Set(turns.map((t) => t.parentId).filter(Boolean));
  return turns.filter((t) => !hasKid.has(t.id)).sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
}

/** Markdown stripped to one plain line, for previews. */
export const plain = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function lastText(t: TurnNode) {
  for (let i = t.events.length - 1; i >= 0; i--) {
    const e = t.events[i];
    if (e.t === 'text' && e.text.trim()) return plain(e.text);
  }
  return '';
}

export function currentActivity(t: TurnNode) {
  const e = t.events[t.events.length - 1];
  if (!e) return 'Thinking…';
  if (e.t === 'tool' && e.result == null) return `${e.name}…`;
  return lastText(t) || 'Working…';
}
