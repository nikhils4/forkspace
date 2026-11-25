import { Suspense, createContext, lazy, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { TerminalInfo } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { onTerminal, request, send, toast, useStore } from './store.ts';

// xterm is big: it loads the first time a shell shows, same as the terminal panel.
const TermView = lazy(() => import('./Terminal.tsx').then((m) => ({ default: m.TermView })));

// One shell per task, for the Run buttons on commands. It starts in the task's folder and stays
// open, so a `cd` in one command carries to the next. Fresh closes it and starts again.

type Shell = { run: (cmd: string) => void; box: ReactNode };
const ShellCtx = createContext<Shell | null>(null);
export const useTaskRun = () => useContext(ShellCtx)?.run ?? null;
export const TaskShellBox = () => <>{useContext(ShellCtx)?.box ?? null}</>;

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
const clean = (cmd: string) => {
  const lines = cmd.replace(/\s+$/, '').split('\n');
  return lines.some((l) => /^\s*\$ /.test(l))
    ? lines
        .filter((l) => /^\s*\$ /.test(l))
        .map((l) => l.replace(/^\s*\$ /, ''))
        .join('\n')
    : lines.join('\n');
};

export function TaskShell({ rootId, branchId, children }: { rootId: string; branchId: string; children: ReactNode }) {
  const { branches, connected } = useStore();
  const boardId = branches[branchId]?.boardId;
  const tag = `run:${rootId}`;
  const [term, setTerm] = useState<TerminalInfo | null>(null);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState('');
  const [last, setLast] = useState('');
  const starting = useRef<Promise<TerminalInfo | null> | null>(null);

  // Find this task's shell if it's still open (after a reload, or coming back to the task).
  const find = () =>
    boardId
      ? request<TerminalInfo[]>({ type: 'termList', boardId }).then(
          (l) => {
            const t = l.filter((x) => x.tag === tag && x.exited === undefined).at(-1) ?? null;
            setTerm(t);
            return t;
          },
          () => null,
        )
      : Promise.resolve(null);
  useEffect(() => {
    setTerm(null);
    setShown(false);
    setError('');
    if (connected) void find();
  }, [rootId, connected]);
  useEffect(
    () =>
      onTerminal((m) => {
        if (m.type === 'termList' && m.boardId === boardId) void find();
        if (m.type === 'termExit' && m.id === term?.id) setTerm((t) => (t ? { ...t, exited: m.code } : t));
      }),
    [boardId, term?.id],
  );

  const open = () => {
    if (!starting.current)
      starting.current = (async () => {
        try {
          const t = await request<TerminalInfo>({ type: 'termOpen', boardId, branchId, cols: 100, rows: 14, tag });
          // A new shell needs its prompt fully drawn before it takes typing, or the first letters
          // get lost. Wait until it has printed something and then gone quiet.
          await new Promise<void>((res) => {
            let quiet: ReturnType<typeof setTimeout> | undefined;
            const done = () => (off(), clearTimeout(quiet), clearTimeout(cap), res());
            const off = onTerminal((m) => {
              if (m.type !== 'termData' || m.id !== t.id) return;
              clearTimeout(quiet);
              quiet = setTimeout(done, 450);
            });
            const cap = setTimeout(done, 5000);
          });
          setError('');
          setTerm(t);
          return t;
        } catch (e: any) {
          setError(e.message);
          return null;
        } finally {
          starting.current = null;
        }
      })();
    return starting.current;
  };

  const run = async (raw: string) => {
    const cmd = clean(raw);
    if (!cmd.trim()) return;
    setShown(true);
    let t = term && term.exited === undefined ? term : null;
    if (t?.running) return toast(`Still running ${t.running}. Stop it first.`, 'error');
    if (!t) t = await open();
    if (!t) return;
    setLast(cmd.split('\n')[0]);
    // Several lines go in as one paste so the shell takes them as one block (zsh), or line by line.
    const multi = cmd.includes('\n');
    const data = multi && /zsh/.test(t.title) ? `\x1b[200~${cmd}\x1b[201~\r` : `${cmd.replace(/\r?\n/g, '\r')}\r`;
    send({ type: 'termInput', id: t.id, data });
  };

  const fresh = async () => {
    if (term) send({ type: 'termClose', id: term.id });
    setTerm(null);
    setLast('');
    setShown(true);
    await open();
  };

  const live = term && term.exited === undefined ? term : null;
  const folder = (branches[branchId]?.cwd ?? '').replace(/\/+$/, '').split('/').pop();
  const box =
    shown && (live || error) ? (
      <section className="rb" aria-label="Command output">
        <div className="rb-bar">
          <Icon name="terminal" size={13} />
          <span className="rb-where" title={live?.cwd}>
            {folder || 'Terminal'}
          </span>
          {live?.running ? (
            <span className="rb-state run">
              <span className="spinner" /> {live.running}
            </span>
          ) : (
            last && <code className="rb-last">{last}</code>
          )}
          <span className="spacer" />
          {live?.running && (
            <button className="rb-btn" onClick={() => send({ type: 'termInput', id: live.id, data: '\x03' })} title="Stop it (Ctrl+C)">
              <Icon name="stop" size={11} /> Stop
            </button>
          )}
          <button className="rb-btn" onClick={() => void fresh()} title="Close this shell and start a new one in the task's folder">
            <Icon name="refresh" size={11} /> Fresh
          </button>
          <button className="icon-btn sm" onClick={() => setShown(false)} title="Hide. The shell keeps running" aria-label="Hide output">
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className="rb-body term-body">{error && !live ? <div className="term-empty">{error}</div> : live && (
            <Suspense fallback={null}>
              <TermView key={live.id} info={live} active />
            </Suspense>
          )}</div>
      </section>
    ) : null;

  return <ShellCtx.Provider value={boardId ? { run: (c) => void run(c), box } : null}>{children}</ShellCtx.Provider>;
}
