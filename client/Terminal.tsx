import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import type { Board, TerminalInfo } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { onTerminal, request, send, useStore } from './store.ts';
import { useResolvedTheme } from './theme.ts';

// A real terminal at the bottom of the board, in the folder of the branch you're on.
// Terminals keep running when the panel is closed; reopening shows what was on screen.

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function themeFor(dark: boolean) {
  return {
    background: css('--bg-2') || (dark ? '#0e0f14' : '#fafafa'),
    foreground: css('--text') || (dark ? '#ecedf2' : '#14151b'),
    cursor: css('--accent') || '#8b9cff',
    cursorAccent: css('--bg-2'),
    selectionBackground: dark ? 'rgba(139,156,255,0.3)' : 'rgba(80,90,200,0.2)',
    black: dark ? '#1b1c25' : '#2e3040',
    brightBlack: dark ? '#6c6f82' : '#8a8d9e',
    red: '#ff6b6b',
    green: dark ? '#4ade80' : '#16a34a',
    yellow: dark ? '#f5a524' : '#b45309',
    blue: dark ? '#8b9cff' : '#4f5bd5',
    magenta: dark ? '#c084fc' : '#9333ea',
    cyan: dark ? '#5ec8e5' : '#0e7490',
    white: dark ? '#ecedf2' : '#3b3d4a',
    brightWhite: dark ? '#ffffff' : '#14151b',
  };
}

function TermView({ info, active }: { info: TerminalInfo; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const theme = useResolvedTheme();

  useEffect(() => {
    const t = new XTerm({
      fontFamily: css('--mono') || 'Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: themeFor(theme === 'dark'),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    // Show what was on screen, then stream what comes next.
    request<TerminalInfo & { buffer: string }>({ type: 'termAttach', id: info.id }).then(
      (r) => t.write(r.buffer),
      () => {},
    );
    const off = onTerminal((m) => {
      if (m.type === 'termData' && m.id === info.id) t.write(m.data);
      if (m.type === 'termExit' && m.id === info.id) t.write(`\r\n\x1b[2m[process exited with code ${m.code}]\x1b[0m\r\n`);
    });
    const input = t.onData((data) => send({ type: 'termInput', id: info.id, data }));
    const resize = t.onResize(({ cols, rows }) => send({ type: 'termResize', id: info.id, cols, rows }));
    const ro = new ResizeObserver(() => {
      if (!host.current?.offsetParent) return;
      try {
        f.fit();
      } catch {}
    });
    ro.observe(host.current!);
    return () => {
      off();
      input.dispose();
      resize.dispose();
      ro.disconnect();
      t.dispose();
    };
  }, [info.id]);

  useEffect(() => {
    if (term.current) term.current.options.theme = themeFor(theme === 'dark');
  }, [theme]);

  useEffect(() => {
    if (!active) return;
    setTimeout(() => {
      try {
        fit.current?.fit();
      } catch {}
      term.current?.focus();
    }, 30);
  }, [active]);

  return <div className={`term-view ${active ? 'on' : ''}`} ref={host} />;
}

export function TerminalPanel({ board, branchId, onClose }: { board: Board; branchId?: string; onClose: () => void }) {
  const { connected, branches } = useStore();
  const [list, setList] = useState<TerminalInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [height, setHeight] = useState(() => {
    try {
      return Number(localStorage.getItem('forkspace:term-h')) || 280;
    } catch {
      return 280;
    }
  });
  const opened = useRef(false);

  const load = () =>
    request<TerminalInfo[]>({ type: 'termList', boardId: board.id }).then(
      (l) => {
        setError('');
        setList(l);
        setActive((a) => (a && l.some((t) => t.id === a) ? a : (l[l.length - 1]?.id ?? null)));
        return l;
      },
      (e: Error) => {
        setError(e.message);
        return [] as TerminalInfo[];
      },
    );

  const open = async () => {
    try {
      const t = await request<TerminalInfo>({ type: 'termOpen', boardId: board.id, branchId, cols: 100, rows: 24 });
      setList((l) => [...l.filter((x) => x.id !== t.id), t]);
      setActive(t.id);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // First open on a board: start a terminal if there isn't one yet.
  useEffect(() => {
    if (!connected) return;
    opened.current = false;
    load().then((l) => {
      if (!l.length && !opened.current && !error) {
        opened.current = true;
        open();
      }
    });
  }, [board.id, connected]);

  useEffect(() => onTerminal((m) => m.type === 'termList' && m.boardId === board.id && void load()), [board.id]);

  const close = (id: string) => {
    send({ type: 'termClose', id });
    setList((l) => l.filter((t) => t.id !== id));
    if (active === id) setActive(list.filter((t) => t.id !== id).at(-1)?.id ?? null);
  };

  const drag = (e: React.PointerEvent) => {
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => setHeight(Math.max(140, Math.min(innerHeight - 160, startH + (startY - ev.clientY))));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      setHeight((h) => {
        try {
          localStorage.setItem('forkspace:term-h', String(h));
        } catch {}
        return h;
      });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const where = (t: TerminalInfo) => {
    const b = t.branchId ? branches[t.branchId] : undefined;
    return b?.gitBranch ? b.gitBranch.replace('forkspace/', '') : 'main folder';
  };

  return (
    <div className="term-panel" style={{ height }}>
      <div className="term-grip" onPointerDown={drag} title="Drag to resize" />
      <div className="term-bar">
        <Icon name="terminal" size={14} />
        <div className="term-tabs">
          {list.map((t) => (
            <div key={t.id} className={`term-tab ${t.id === active ? 'on' : ''} ${t.exited !== undefined ? 'exited' : ''}`} onClick={() => setActive(t.id)}>
              <span>{t.title}</span>
              <em>{where(t)}</em>
              <button
                aria-label="Close terminal"
                title="Close terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  close(t.id);
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
          <button className="term-new" onClick={open} title="New terminal in this branch's folder" aria-label="New terminal">
            <Icon name="plus" size={13} />
          </button>
        </div>
        <span className="spacer" />
        <button className="icon-btn sm" onClick={onClose} title="Hide (Ctrl+`). Terminals keep running" aria-label="Hide terminal">
          <Icon name="chevronDown" size={15} />
        </button>
      </div>
      <div className="term-body">
        {error ? (
          <div className="term-empty">{error}</div>
        ) : !list.length ? (
          <div className="term-empty">
            <button className="btn sm" onClick={open}>
              <Icon name="terminal" size={13} /> New terminal
            </button>
          </div>
        ) : (
          list.map((t) => <TermView key={t.id} info={t} active={t.id === active} />)
        )}
      </div>
    </div>
  );
}
