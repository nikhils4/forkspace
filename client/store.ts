import { useSyncExternalStore } from 'react';
import type { Board, Branch, CanvasNode, ClientMsg, ServerMsg } from '../shared/types.ts';

export interface Snapshot {
  connected: boolean;
  home: string;
  boards: Board[];
  branches: Record<string, Branch>;
  nodes: Record<string, CanvasNode>;
  toasts: { id: number; level: 'info' | 'error'; text: string }[];
}

let snap: Snapshot = { connected: false, home: '', boards: [], branches: {}, nodes: {}, toasts: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<Snapshot>) => {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
};

export const useStore = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => snap,
  );

let ws: WebSocket | null = null;
const waiting = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let toastId = 0;

export function toast(text: string, level: 'info' | 'error' = 'info') {
  const id = ++toastId;
  set({ toasts: [...snap.toasts, { id, level, text }] });
  setTimeout(() => set({ toasts: snap.toasts.filter((t) => t.id !== id) }), level === 'error' ? 7000 : 3500);
}

function onMessage(msg: ServerMsg) {
  switch (msg.type) {
    case 'state':
      set({
        home: msg.home,
        boards: msg.state.boards,
        branches: Object.fromEntries(msg.state.branches.map((b) => [b.id, b])),
        nodes: Object.fromEntries(msg.state.nodes.map((n) => [n.id, n])),
      });
      break;
    case 'board': {
      const i = snap.boards.findIndex((b) => b.id === msg.board.id);
      set({ boards: i < 0 ? [...snap.boards, msg.board] : snap.boards.map((b) => (b.id === msg.board.id ? msg.board : b)) });
      break;
    }
    case 'boardDeleted':
      set({
        boards: snap.boards.filter((b) => b.id !== msg.id),
        nodes: Object.fromEntries(Object.entries(snap.nodes).filter(([, n]) => n.boardId !== msg.id)),
      });
      break;
    case 'branch':
      set({ branches: { ...snap.branches, [msg.branch.id]: msg.branch } });
      break;
    case 'node':
      set({ nodes: { ...snap.nodes, [msg.node.id]: msg.node } });
      break;
    case 'nodesDeleted': {
      const nodes = { ...snap.nodes };
      msg.ids.forEach((id) => delete nodes[id]);
      set({ nodes });
      break;
    }
    case 'reply': {
      const w = waiting.get(msg.reqId);
      waiting.delete(msg.reqId);
      if (msg.ok) w?.resolve(msg.data);
      else w?.reject(new Error(msg.error));
      break;
    }
    case 'toast':
      toast(msg.text, msg.level);
      break;
  }
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => set({ connected: true });
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    set({ connected: false });
    for (const w of waiting.values()) w.reject(new Error('Disconnected'));
    waiting.clear();
    setTimeout(connect, 1000);
  };
}

/** Fire-and-forget message. */
export function send(msg: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else toast('Not connected to the Forkspace server', 'error');
}

type WithReq = Extract<ClientMsg, { reqId: string }>;
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

/** Message that expects a reply. */
export function request<T = unknown>(msg: DistributiveOmit<WithReq, 'reqId'>): Promise<T> {
  const reqId = Math.random().toString(36).slice(2);
  return new Promise<T>((resolve, reject) => {
    if (ws?.readyState !== WebSocket.OPEN) return reject(new Error('Not connected'));
    waiting.set(reqId, { resolve, reject });
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
}

/** Optimistic local update (server echo will follow). */
export function patchNode(node: CanvasNode) {
  set({ nodes: { ...snap.nodes, [node.id]: node } });
}

export const getSnapshot = () => snap;
