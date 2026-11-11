import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { CanvasNode } from '../shared/types.ts';
import { isLive, isTurn } from './tree.ts';

// Cards that finished while you weren't looking: "Ready for review" until you click the card,
// open it, or start the next step from it. Kept in this browser only.

const KEY = 'forkspace:ready';
const load = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch {
    return new Set();
  }
};
let ready = load();
const listeners = new Set<() => void>();
const save = (next: Set<string>) => {
  ready = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {}
  listeners.forEach((l) => l());
};

export const useReady = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => ready,
  );

export const clearReady = (id: string | null | undefined) => {
  if (!id || !ready.has(id)) return;
  const next = new Set(ready);
  next.delete(id);
  save(next);
};

/** Watches every card: working → done (or failed) marks it ready; a new step from it, or deleting it, clears it. */
export function useWatchFinishes(nodes: Record<string, CanvasNode>, loaded: boolean) {
  const wasLive = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const live = new Set<string>();
    const next = new Set(ready);
    for (const n of Object.values(nodes)) {
      if (!isTurn(n)) continue;
      if (isLive(n)) {
        live.add(n.id);
        // You gave it something next: the step it grew from no longer waits for you.
        if (n.parentId) next.delete(n.parentId);
        next.delete(n.id);
      } else if (wasLive.current?.has(n.id) && (n.status === 'done' || n.status === 'error')) next.add(n.id);
    }
    for (const id of next) if (!nodes[id]) next.delete(id);
    wasLive.current = live;
    if (next.size !== ready.size || [...next].some((id) => !ready.has(id))) save(next);
  }, [nodes, loaded]);
}
