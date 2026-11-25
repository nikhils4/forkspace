import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Icon } from './icons.tsx';
import type { TerminalInfo } from '../shared/types.ts';
import { request, runInTerminal, toast } from './store.ts';

// One shell per task for the Run buttons on commands. Run opens the terminal panel at the bottom and
// runs it in the task's own tab, which starts in the task's folder and stays open, so a `cd` in one
// command carries to the next. Fresh in the panel starts that tab over.
//
// Each command remembers that it ran: Running while it goes, then a green Ran that stays, so you
// don't run the same thing twice by accident. Running a Ran one again takes a second click.

type Shell = { run: (cmd: string) => void; rootId: string };
const ShellCtx = createContext<Shell | null>(null);
export const useTaskRun = () => useContext(ShellCtx)?.run ?? null;

const SHELL_LANGS = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'terminal', 'fish']);
/** Shell code blocks only. A block with no language counts when it reads like one short command. */
export function runnable(code: string, lang: string) {
  const l = lang.trim().toLowerCase();
  if (!SHELL_LANGS.has(l)) return false;
  if (l) return true;
  const lines = code.trim().split('\n');
  return lines.length <= 3 && /^\$?\s*(npm|npx|yarn|pnpm|bun|node|git|cd|ls|make|cargo|go|python3?|pip|uv|docker|curl|brew|deno|tsc|vite|pytest|bundle|rails|swift|xcodebuild|open|cat|mkdir|rm|cp|mv|chmod|export|source|\.\/)\b/.test(lines[0]);
}
/** Drop prompt marks ("$ npm test") and trailing output-only lines from a pasted session. */
export const clean = (cmd: string) => {
  const lines = cmd.replace(/\s+$/, '').split('\n');
  return lines.some((l) => /^\s*\$ /.test(l))
    ? lines
        .filter((l) => /^\s*\$ /.test(l))
        .map((l) => l.replace(/^\s*\$ /, ''))
        .join('\n')
    : lines.join('\n');
};

// ---- What ran: per task tag + command, kept in this browser so it survives a reload. ----
export type RunState = { state: 'running' | 'done'; at: number };
const KEY = 'forkspace.ran';
const runs = new Map<string, RunState>();
try {
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, RunState>)) runs.set(k, { ...v, state: 'done' });
} catch {}
const subs = new Set<() => void>();
let version = 0;
const runKey = (tag: string, cmd: string) => `${tag}\n${cmd.trim()}`;
function save() {
  version++;
  subs.forEach((f) => f());
  try {
    // Keep the latest 300 so it never grows without end.
    const keep = [...runs.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 300);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch {}
}
// Sent commands we're waiting on. Done when the shell is back at its prompt: we saw something running
// and now nothing is, or nothing ever showed up (cd, export, a quick echo).
type Watch = { boardId: string; termId: string; tag: string; cmd: string; at: number; seen: boolean };
const watching = new Map<string, Watch>();
let timer: ReturnType<typeof setInterval> | null = null;
const short = (cmd: string) => {
  const one = cmd.split('\n')[0].trim();
  return one.length > 48 ? `${one.slice(0, 47)}…` : one;
};
function finish(k: string, w: Watch, ended = false) {
  watching.delete(k);
  const r = runs.get(k);
  if (r?.state !== 'running') return;
  runs.set(k, { state: 'done', at: Date.now() });
  save();
  if (!ended) toast(`✓ Ran ${short(w.cmd)}`);
}
async function tick() {
  if (!watching.size) {
    if (timer) clearInterval(timer);
    timer = null;
    return;
  }
  const boards = new Set([...watching.values()].map((w) => w.boardId));
  for (const boardId of boards) {
    let list: TerminalInfo[];
    try {
      list = await request<TerminalInfo[]>({ type: 'termList', boardId });
    } catch {
      continue;
    }
    for (const [k, w] of watching) {
      if (w.boardId !== boardId) continue;
      const t = list.find((x) => x.id === w.termId);
      if (!t || t.exited !== undefined) finish(k, w, true);
      else if (t.running) w.seen = true;
      else if (w.seen || Date.now() - w.at > 3200) finish(k, w);
    }
  }
}
/** Clicked: show Running right away, while the terminal opens. */
const beforeStart = new Map<string, RunState | undefined>();
function markStarting(tag: string, cmd: string) {
  const k = runKey(tag, cmd);
  const before = runs.get(k);
  beforeStart.set(k, before);
  runs.set(k, { state: 'running', at: Date.now() });
  save();
  // If the terminal never takes it (say, something else is still running there), go back.
  setTimeout(() => {
    if (watching.has(k) || runs.get(k)?.state !== 'running') return;
    if (before) runs.set(k, before);
    else runs.delete(k);
    save();
  }, 8000);
}
/** The terminal turned it down (something else is still running). */
export function markRefused(tag: string, cmd: string) {
  const k = runKey(tag, cmd);
  if (watching.has(k)) return;
  const before = beforeStart.get(k);
  if (before) runs.set(k, before);
  else runs.delete(k);
  save();
}
/** The terminal sent it: show Running until the shell is back at its prompt. */
export function markRunning(boardId: string, termId: string, tag: string, cmd: string) {
  const k = runKey(tag, cmd);
  runs.set(k, { state: 'running', at: Date.now() });
  save();
  watching.set(k, { boardId, termId, tag, cmd, at: Date.now(), seen: false });
  timer ??= setInterval(tick, 1000);
}
/** Fresh shell: anything still marked running there has stopped. */
export function settleTag(tag: string) {
  let changed = false;
  for (const [k, r] of runs)
    if (k.startsWith(`${tag}\n`) && r.state === 'running') {
      runs.set(k, { state: 'done', at: Date.now() });
      watching.delete(k);
      changed = true;
    }
  if (changed) save();
}
function useRunState(tag: string | null, cmd: string) {
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => version,
  );
  return tag ? runs.get(runKey(tag, cmd)) : undefined;
}

const ago = (at: number) => {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

/** Run, then Running, then a green Ran that stays. A Ran one asks before running again. */
export function RunButton({ cmd, className }: { cmd: string; className: string }) {
  const ctx = useContext(ShellCtx);
  const c = clean(cmd);
  const r = useRunState(ctx ? `run:${ctx.rootId}` : null, c);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(t);
  }, [confirm]);
  if (!ctx || !c.trim()) return null;
  const go = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (r?.state === 'running') return;
    if (r?.state === 'done' && !confirm) return setConfirm(true);
    setConfirm(false);
    ctx.run(cmd);
  };
  const state = confirm ? 'again' : (r?.state ?? 'idle');
  return (
    <button
      className={`${className} run-${state}`}
      onClick={go}
      title={state === 'running' ? `Running\n${c}` : state === 'done' ? `Ran ${ago(r!.at)}. Click to run it again.\n${c}` : `Run it here\n${c}`}
      aria-label={state === 'done' ? 'Ran. Run again' : 'Run this command'}
    >
      {state === 'running' ? (
        <>
          <span className="spinner" /> Running
        </>
      ) : state === 'done' ? (
        <>
          <Icon name="check" size={11} /> Ran
        </>
      ) : state === 'again' ? (
        <>
          <Icon name="play" size={10} /> Run again?
        </>
      ) : (
        <>
          <Icon name="play" size={10} /> Run
        </>
      )}
    </button>
  );
}

export function TaskShell({ rootId, branchId, children }: { rootId: string; branchId: string; children: ReactNode }) {
  const run = (raw: string) => {
    const cmd = clean(raw);
    if (!cmd.trim()) return;
    markStarting(`run:${rootId}`, cmd);
    runInTerminal(branchId, `run:${rootId}`, cmd);
  };
  return <ShellCtx.Provider value={{ run, rootId }}>{children}</ShellCtx.Provider>;
}
