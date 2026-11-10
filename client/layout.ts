import type { CanvasNode, Position } from '../shared/types.ts';

export const CARD_W = 380;
const GAP_X = 60;
const GAP_Y = 70;
const DEFAULT_H = 340;

/** Card heights measured by the canvas (cards placed from chat view use estimates). */
export const heights = new Map<string, number>();

const widthOf = (n: CanvasNode) => (n.kind === 'note' ? (n.width ?? 220) : CARD_W);
const heightOf = (n: CanvasNode) => heights.get(n.id) ?? (n.kind === 'note' ? (n.height ?? 160) : DEFAULT_H);

/** Where a new card goes: under its parent, beside the parent's other children, or to the right of everything for a new thread. */
export function placeFor(all: Record<string, CanvasNode>, boardId: string, parentId: string | null, fallback: Position): Position {
  const items = Object.values(all).filter((n) => n.boardId === boardId);
  if (!parentId) {
    const turns = items.filter((n) => n.kind === 'turn');
    if (!turns.length) return items.length ? { x: Math.max(...items.map((n) => n.position.x + widthOf(n))) + GAP_X * 2, y: fallback.y } : fallback;
    const maxX = Math.max(...items.map((n) => n.position.x + widthOf(n)));
    const minY = Math.min(...turns.map((n) => n.position.y));
    return { x: maxX + GAP_X * 2, y: minY };
  }
  const parent = all[parentId];
  const y = parent.position.y + heightOf(parent) + GAP_Y;
  const siblings = items.filter((n) => n.kind === 'turn' && n.parentId === parentId);
  if (!siblings.length) return { x: parent.position.x, y };
  // Right of anything already occupying that band.
  const band = items.filter((n) => n.position.y < y + DEFAULT_H && n.position.y + heightOf(n) > y && n.position.x >= parent.position.x - 10);
  const right = Math.max(parent.position.x, ...band.map((n) => n.position.x + widthOf(n) - CARD_W));
  return { x: right + CARD_W + GAP_X, y };
}
