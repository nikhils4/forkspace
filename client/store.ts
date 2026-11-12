import { useSyncExternalStore } from 'react';
import type { Board, Branch, CanvasNode, ClientMsg, ServerMsg, UpdateInfo } from '../shared/types.ts';

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
  /** Live progress of an update started from this or another device. */
  update?: { stage: string; done?: boolean; error?: string };
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
let build: string | null = null;
const updateListeners = new Set<(i: UpdateInfo) => void>();
type TermMsg = Extract<ServerMsg, { type: 'termData' | 'termExit' | 'termList' }>;
const termListeners = new Set<(m: TermMsg) => void>();
/** Terminal output and changes, as they stream in. */
export function onTerminal(f: (m: TermMsg) => void) {
  termListeners.add(f);
  return () => void termListeners.delete(f);
}
/** Hear about new releases the moment the server finds them. */
export function onUpdateInfo(f: (i: UpdateInfo) => void) {
  updateListeners.add(f);
  return () => void updateListeners.delete(f);
}
const mapListeners = new Set<(m: { boardId: string; text: string }) => void>();
/** What the map builder (or a question about the map) is reading right now. */
export function onMapProgress(f: (m: { boardId: string; text: string }) => void) {
  mapListeners.add(f);
  return () => void mapListeners.delete(f);
}
const waiting = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let retry: number | undefined;
let backoff = 500;

function onMessage(msg: ServerMsg) {
  switch (msg.type) {
    case 'state':
      // A different build after reconnecting means Forkspace was updated: load the new app.
      if (build && msg.build && build !== msg.build) {
        location.reload();
        return;
      }
      build = msg.build;
      // Remember how to start Forkspace, for the screen shown when it is not running.
      try {
        localStorage.setItem('forkspace:start', msg.startCommand);
      } catch {}
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
    case 'termData':
    case 'termExit':
    case 'termList':
      termListeners.forEach((f) => f(msg));
      break;
    case 'updateInfo':
      updateListeners.forEach((f) => f(msg.info));
      break;
    case 'mapProgress':
      mapListeners.forEach((f) => f(msg));
      break;
    case 'updateProgress':
      set({ update: { stage: msg.stage, done: msg.done, error: msg.error } });
      if (msg.done) toast(msg.stage);
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
    // 1012 = the server is restarting on purpose (an update, or moving to the background).
    if (e.code === 1012 && !(snap.update && !snap.update.done)) set({ update: { stage: e.reason || 'Restarting…' } });
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
/**
 * Coming back to the app (phone unlocked, tab shown): a socket can look open but be dead after
 * the network changed. Ask the server something small; no answer in 3 s means reconnect.
 */
async function checkAlive() {
  if (!snap.connected) return reconnectNow();
  const ok = await Promise.race([request({ type: 'ping' }).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
  if (!ok) {
    const dead = ws;
    ws = null;
    dead?.close();
    set({ connected: false });
    for (const w of waiting.values()) w.reject(new Error('Disconnected'));
    waiting.clear();
    backoff = 500;
    connect();
  }
}
document.addEventListener('visibilitychange', () => {
  sendPresence();
  if (document.visibilityState === 'visible') checkAlive();
});
window.addEventListener('pageshow', (e) => e.persisted && checkAlive());
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

/** Open a terminal in a card's own folder (its menu's "Terminal here"). The app shows the panel and opens it. */
export const openTerminalFor = (branchId: string) => dispatchEvent(new CustomEvent('forkspace:term-for', { detail: branchId }));
