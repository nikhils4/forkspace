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

  // The nearest free spot right of the parent among the thread's own cards.
  const root = rootOf(all, parentId);
  const inBand = (n: CanvasNode) => n.id !== parentId && n.position.y < y + DEFAULT_H && n.position.y + heightOf(n) > y;
  const own = items.filter((n) => n.kind === 'turn' && rootOf(all, n.id) === root && inBand(n));
  const overlaps = (n: CanvasNode, x: number) => n.position.x < x + CARD_W + GAP_X / 2 && n.position.x + widthOf(n) + GAP_X / 2 > x;
  let x = parent.position.x + CARD_W + GAP_X;
  for (let hit = own.filter((n) => overlaps(n, x)); hit.length; hit = own.filter((n) => overlaps(n, x)))
    x = Math.max(...hit.map((n) => n.position.x + widthOf(n))) + GAP_X;

  // Other threads (and notes) in the way slide right, everything to their right with them,
  // so the fork sits beside its own thread instead of past every other one.
  const others = items.filter((n) => !(n.kind === 'turn' && rootOf(all, n.id) === root) && n.position.x > parent.position.x);
  const blocking = others.filter((n) => inBand(n) && overlaps(n, x));
  if (!blocking.length) return { position: { x, y }, moves: [] };
  const shift = x + CARD_W + GAP_X - Math.min(...blocking.map((n) => n.position.x));
  const from = Math.min(...blocking.map((n) => n.position.x));
  const moves = others.filter((n) => n.position.x >= from).map((n) => ({ id: n.id, position: { x: n.position.x + shift, y: n.position.y } }));
  return { position: { x, y }, moves };
}

export const placeFor = (all: Record<string, CanvasNode>, boardId: string, parentId: string | null, fallback: Position) =>
  placement(all, boardId, parentId, fallback).position;
