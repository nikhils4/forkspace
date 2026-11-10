import { useSyncExternalStore } from 'react';
import type { Board, Branch, CanvasNode, ClientMsg, ServerMsg } from '../shared/types.ts';

export type AuthState = 'checking' | 'pairing' | 'ok' | 'unreachable';

export interface Snapshot {
  auth: AuthState;
  connected: boolean;
  /** True once the first state snapshot arrived. */
  loaded: boolean;
  home: string;
  boards: Board[];
  branches: Record<string, Branch>;
  nodes: Record<string, CanvasNode>;
  toasts: { id: number; level: 'info' | 'error'; text: string }[];
}

let snap: Snapshot = { auth: 'checking', connected: false, loaded: false, home: '', boards: [], branches: {}, nodes: {}, toasts: [] };
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
export const getSnapshot = () => snap;

// ---- access key ----
const KEY = 'forkspace:token';
const store = {
  get: () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY);
    } catch {}
  },
};
let token: string | null = store.get();
export const getToken = () => token;

export const isLocalPage = () => ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

// ---- toasts ----
let toastId = 0;
export function toast(text: string, level: 'info' | 'error' = 'info') {
  const id = ++toastId;
  set({ toasts: [...snap.toasts, { id, level, text }] });
  setTimeout(() => set({ toasts: snap.toasts.filter((t) => t.id !== id) }), level === 'error' ? 6000 : 3000);
}

// ---- socket ----
let ws: WebSocket | null = null;
const waiting = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let retry: number | undefined;
let backoff = 500;

function onMessage(msg: ServerMsg) {
  switch (msg.type) {
    case 'state':
      set({
        loaded: true,
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

async function obtainToken(): Promise<'ok' | 'pairing' | 'unreachable'> {
  // A ?pair=123456 link (from the QR code) signs this device in.
  const params = new URLSearchParams(location.search);
  const code = params.get('pair');
  if (code) {
    params.delete('pair');
    history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : '') + location.hash);
    try {
      await pair(code);
      return 'ok';
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }

  if (token) {
    try {
      const r = await fetch('/api/check', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (r.ok) return 'ok';
      if (r.status === 401) {
        token = null;
        store.set(null);
      }
    } catch {
      return 'unreachable';
    }
  }

  if (!token) {
    try {
      const r = await fetch('/api/local-token', { cache: 'no-store' });
      if (r.ok) {
        token = (await r.json()).token;
        store.set(token);
        return 'ok';
      }
      return 'pairing';
    } catch {
      return 'unreachable';
    }
  }
  return 'ok';
}

export async function pair(code: string) {
  const r = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Pairing failed');
  token = data.token;
  store.set(token);
  set({ auth: 'checking' });
  connect();
}

export async function connect() {
  clearTimeout(retry);
  const result = await obtainToken();
  if (result !== 'ok') {
    set({ auth: result, connected: false });
    if (result === 'unreachable') scheduleRetry();
    return;
  }
  set({ auth: 'ok' });
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws?.close();
  const sock = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(token!)}`);
  ws = sock;
  sock.onopen = () => {
    backoff = 500;
    set({ connected: true });
    sendPresence();
  };
  sock.onmessage = (e) => onMessage(JSON.parse(e.data));
  sock.onclose = (e) => {
    if (ws !== sock) return;
    set({ connected: false });
    for (const w of waiting.values()) w.reject(new Error('Disconnected'));
    waiting.clear();
    if (e.code === 4001) {
      token = null;
      store.set(null);
    }
    scheduleRetry();
  };
}

function scheduleRetry() {
  clearTimeout(retry);
  retry = window.setTimeout(connect, backoff);
  backoff = Math.min(backoff * 1.6, 8000);
}

/** Reconnect right away (e.g. the phone app came back to the foreground). */
export function reconnectNow() {
  if (snap.connected) return;
  backoff = 500;
  connect();
}

export function setToken(t: string) {
  token = t;
  store.set(t);
}

function sendPresence() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'presence', visible: document.visibilityState === 'visible' }));
}
document.addEventListener('visibilitychange', () => {
  sendPresence();
  if (document.visibilityState === 'visible') reconnectNow();
});
window.addEventListener('online', reconnectNow);

/** Fire-and-forget message. */
export function send(msg: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else toast('Not connected to your Mac yet', 'error');
}

type WithReq = Extract<ClientMsg, { reqId: string }>;
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

/** Message that expects a reply. */
export function request<T = unknown>(msg: DistributiveOmit<WithReq, 'reqId'>): Promise<T> {
  const reqId = Math.random().toString(36).slice(2);
  return new Promise<T>((resolve, reject) => {
    if (ws?.readyState !== WebSocket.OPEN) return reject(new Error('Not connected to your Mac'));
    waiting.set(reqId, { resolve, reject });
    ws.send(JSON.stringify({ ...msg, reqId }));
  });
}
