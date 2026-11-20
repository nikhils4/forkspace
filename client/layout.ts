import type { CanvasNode, Position } from '../shared/types.ts';

export const CARD_W = 380;
const GAP_X = 60;
const GAP_Y = 70;
const DEFAULT_H = 340;

/** Card heights measured by the canvas (cards placed from chat view use estimates). */
export const heights = new Map<string, number>();

const widthOf = (n: CanvasNode) => (n.kind === 'note' ? (n.width ?? 220) : CARD_W);
const heightOf = (n: CanvasNode) => heights.get(n.id) ?? (n.kind === 'note' ? (n.height ?? 160) : DEFAULT_H);

const rootOf = (all: Record<string, CanvasNode>, id: string) => {
  let n = all[id];
  while (n?.kind === 'turn' && n.parentId && all[n.parentId]) n = all[n.parentId];
  return n?.id;
};

export interface Placement {
  position: Position;
  /** Cards to slide right first so the new one fits beside its own thread. */
  moves: { id: string; position: Position }[];
}

/** Where a new card goes: under its parent, beside the parent's other children, or to the right of everything for a new thread. */
export function placement(all: Record<string, CanvasNode>, boardId: string, parentId: string | null, fallback: Position): Placement {
  const items = Object.values(all).filter((n) => n.boardId === boardId);
  if (!parentId) {
    const turns = items.filter((n) => n.kind === 'turn');
    if (!turns.length) return { position: items.length ? { x: Math.max(...items.map((n) => n.position.x + widthOf(n))) + GAP_X * 2, y: fallback.y } : fallback, moves: [] };
    const maxX = Math.max(...items.map((n) => n.position.x + widthOf(n)));
    const minY = Math.min(...turns.map((n) => n.position.y));
    return { position: { x: maxX + GAP_X * 2, y: minY }, moves: [] };
  }
  const parent = all[parentId];
  const y = parent.position.y + heightOf(parent) + GAP_Y;
  const siblings = items.filter((n) => n.kind === 'turn' && n.parentId === parentId);
  if (!siblings.length) return { position: { x: parent.position.x, y }, moves: [] };

  // Fan out like a tree: the parent's children sit side by side, centred under it, the new one
  // on the right. Existing children (with everything under them) slide left to make room, so the
  // branch lands right under the card it came from, never off past the other threads.
  const kids = new Map<string, CanvasNode[]>();
  for (const n of items) if (n.kind === 'turn' && n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const subtree = (id: string): CanvasNode[] => [all[id], ...(kids.get(id) ?? []).flatMap((k) => subtree(k.id))];
  const groups = siblings
    .sort((a, b) => a.position.x - b.position.x)
    .map((sib) => {
      const cards = subtree(sib.id);
      const left = Math.min(...cards.map((n) => n.position.x));
      return { cards, left, width: Math.max(...cards.map((n) => n.position.x + widthOf(n))) - left };
    });
  const total = groups.reduce((a, g) => a + g.width + GAP_X, 0) + CARD_W;
  let cursor = parent.position.x + CARD_W / 2 - total / 2;
  const moved = new Map<string, Position>();
  for (const g of groups) {
    const dx = cursor - g.left;
    if (Math.abs(dx) > 0.5) for (const n of g.cards) moved.set(n.id, { x: n.position.x + dx, y: n.position.y });
    cursor += g.width + GAP_X;
  }
  const position = { x: cursor, y };
  const L = parent.position.x + CARD_W / 2 - total / 2;
  const R = L + total;

  // Anything else in the way (other threads, notes, cousins) steps aside: left of the fan moves
  // left, right of it moves right.
  const mine = new Set([parentId, ...groups.flatMap((g) => g.cards.map((n) => n.id))]);
  for (let a = all[parentId]; a?.kind === 'turn' && a.parentId; a = all[a.parentId]) mine.add(a.parentId);
  const bottom = Math.max(y + DEFAULT_H, ...[...moved.keys()].map((id) => all[id].position.y + heightOf(all[id])));
  const rest = items.filter((n) => !mine.has(n.id));
  const inWay = rest.filter((n) => n.position.y < bottom && n.position.y + heightOf(n) > y && n.position.x < R + GAP_X / 2 && n.position.x + widthOf(n) + GAP_X / 2 > L);
  const mid = parent.position.x + CARD_W / 2;
  const rightOnes = inWay.filter((n) => n.position.x + widthOf(n) / 2 >= mid);
  const leftOnes = inWay.filter((n) => n.position.x + widthOf(n) / 2 < mid);
  if (rightOnes.length) {
    const from = Math.min(...rightOnes.map((n) => n.position.x));
    const dx = R + GAP_X - from;
    for (const n of rest) if (n.position.x >= from) moved.set(n.id, { x: n.position.x + dx, y: n.position.y });
  }
  if (leftOnes.length) {
    const to = Math.max(...leftOnes.map((n) => n.position.x + widthOf(n)));
    const dx = L - GAP_X - to;
    for (const n of rest) if (n.position.x + widthOf(n) <= to + 1) moved.set(n.id, { x: n.position.x + dx, y: n.position.y });
  }
  return { position, moves: [...moved.entries()].map(([id, position]) => ({ id, position })) };
}

export const placeFor = (all: Record<string, CanvasNode>, boardId: string, parentId: string | null, fallback: Position) =>
  placement(all, boardId, parentId, fallback).position;
