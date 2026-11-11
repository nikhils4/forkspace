import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { nanoid } from 'nanoid';
import type { TerminalInfo } from '../shared/types.ts';
import { HOME } from './store.ts';

// Real terminals in the app, on this machine, through node-pty (the same library VS Code uses).
// Terminals belong to a board and keep their recent output, so closing the panel or a reconnect
// from the phone never loses what was on screen.

type Pty = {
  onData: (f: (d: string) => void) => void;
  onExit: (f: (e: { exitCode: number }) => void) => void;
  write: (d: string) => void;
  resize: (c: number, r: number) => void;
  kill: () => void;
  /** The program in the foreground right now (macOS and Linux). */
  readonly process?: string;
};

interface Term extends TerminalInfo {
  pty: Pty;
  buffer: string;
}

const MAX_TERMS = 10;
const MAX_BUFFER = 256 * 1024;
const terms = new Map<string, Term>();

type Emit = (msg: { type: 'termData'; id: string; data: string } | { type: 'termExit'; id: string; code: number } | { type: 'termList'; boardId: string }) => void;
let emit: Emit = () => {};
export const setTerminalEmitter = (f: Emit) => (emit = f);

// node-pty is optional: Linux needs build tools for it. Without it, the terminal says so.
let ptyLib: { spawn: (file: string, args: string[], opts: object) => Pty } | null | undefined;
function loadPty() {
  if (ptyLib !== undefined) return ptyLib;
  try {
    const require = createRequire(import.meta.url);
    ptyLib = require('node-pty');
    // node-pty 1.1 ships its macOS helper without the execute bit; fix it once.
    const dir = path.dirname(require.resolve('node-pty/package.json'));
    for (const arch of ['darwin-arm64', 'darwin-x64']) {
      const helper = path.join(dir, 'prebuilds', arch, 'spawn-helper');
      try {
        if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
      } catch {}
    }
  } catch {
    ptyLib = null;
  }
  return ptyLib;
}

export const terminalSupported = () => !!loadPty();

function shell() {
  if (process.platform === 'win32') return { file: process.env.COMSPEC || 'powershell.exe', args: [] as string[] };
  const file = process.env.SHELL || (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  return { file, args: ['-l'] };
}

// ---- who may use terminals from another device ----
const FILE = path.join(HOME, 'terminal.json');
let remoteAllowed = false;
try {
  remoteAllowed = !!JSON.parse(fs.readFileSync(FILE, 'utf8')).remoteAllowed;
} catch {}
export const terminalRemoteAllowed = () => remoteAllowed;
export function setTerminalRemoteAllowed(v: boolean) {
  remoteAllowed = v;
  fs.writeFileSync(FILE, JSON.stringify({ remoteAllowed: v }), { mode: 0o600 });
}

const info = (t: Term): TerminalInfo => ({ id: t.id, boardId: t.boardId, branchId: t.branchId, cwd: t.cwd, title: t.title, createdAt: t.createdAt, exited: t.exited, used: t.used, running: t.running });

// Keep each tab's "what's running" up to date (yarn dev, node, vim…). Only tells screens when it changes.
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'login', '-zsh', '-bash', 'powershell.exe', 'cmd.exe', 'pwsh']);
setInterval(() => {
  const changed = new Set<string>();
  for (const t of terms.values()) {
    if (t.exited !== undefined) continue;
    let p = '';
    try {
      p = path.basename(t.pty.process ?? '');
    } catch {}
    const running = p && !SHELLS.has(p) ? p : undefined;
    if (running !== t.running) {
      t.running = running;
      changed.add(t.boardId);
    }
  }
  for (const boardId of changed) emit({ type: 'termList', boardId });
}, 1500).unref();

export function openTerminal(boardId: string, cwd: string, branchId: string | undefined, cols: number, rows: number): TerminalInfo {
  const lib = loadPty();
  if (!lib) throw new Error('The terminal needs node-pty, which could not load here. On Linux, install build tools and run npm install.');
  if (terms.size >= MAX_TERMS) throw new Error(`Up to ${MAX_TERMS} terminals at once. Close one first.`);
  if (!fs.existsSync(cwd)) throw new Error('That folder no longer exists.');
  const { file, args } = shell();
  const pty = lib.spawn(file, args, {
    name: 'xterm-256color',
    cols: Math.max(20, Math.min(400, cols || 100)),
    rows: Math.max(5, Math.min(200, rows || 30)),
    cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORKSPACE: '1' },
  });
  const n = [...terms.values()].filter((t) => t.boardId === boardId).length + 1;
  const t: Term = { id: nanoid(8), boardId, branchId, cwd, title: `${path.basename(file)} ${n}`, createdAt: Date.now(), pty, buffer: '' };
  terms.set(t.id, t);
  pty.onData((d) => {
    t.buffer = (t.buffer + d).slice(-MAX_BUFFER);
    emit({ type: 'termData', id: t.id, data: d });
  });
  pty.onExit(({ exitCode }) => {
    t.exited = exitCode;
    emit({ type: 'termExit', id: t.id, code: exitCode });
  });
  emit({ type: 'termList', boardId });
  return info(t);
}

export const listTerminals = (boardId: string) => [...terms.values()].filter((t) => t.boardId === boardId).map(info);

export function attachTerminal(id: string) {
  const t = terms.get(id);
  if (!t) throw new Error('That terminal is gone.');
  return { ...info(t), buffer: t.buffer };
}

export function writeTerminal(id: string, data: string) {
  const t = terms.get(id);
  if (!t || t.exited !== undefined || typeof data !== 'string') return;
  t.pty.write(data.slice(0, 64 * 1024));
  if (!t.used && /[\r\n]/.test(data)) {
    t.used = true;
    emit({ type: 'termList', boardId: t.boardId });
  }
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const t = terms.get(id);
  if (!t || t.exited !== undefined) return;
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
  try {
    t.pty.resize(Math.max(20, Math.min(400, Math.floor(cols))), Math.max(5, Math.min(200, Math.floor(rows))));
  } catch {}
}

export function closeTerminal(id: string) {
  const t = terms.get(id);
  if (!t) return;
  terms.delete(id);
  try {
    t.pty.kill();
  } catch {}
  emit({ type: 'termList', boardId: t.boardId });
}

/** A board was deleted: its terminals go with it. */
export function closeBoardTerminals(boardId: string) {
  for (const t of [...terms.values()]) if (t.boardId === boardId) closeTerminal(t.id);
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    for (const t of terms.values())
      try {
        t.pty.kill();
      } catch {}
  });

export const homeDir = os.homedir;
