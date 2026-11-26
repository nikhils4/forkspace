import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Board, CanvasNode, TurnNode } from '../shared/types.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { TagBand, TagPicker, tagsOf } from './Tags.tsx';
import { Icon, type IconName } from './icons.tsx';
import { useReady } from './review.ts';
import { STAGE_LABEL, threadsOf, type Stage, type ThreadRow } from './status.ts';
import { send, toast, useStore } from './store.ts';
import { timeAgo, useTick } from './ui.tsx';
import { childrenOf, isLive, isTurn, pathTo } from './tree.ts';

// The desktop frame: a tab per task along the top, the page in the middle, a status bar below.

export type Pinned = 'stacks' | 'canvas' | 'code' | 'map';
export type ActiveTab = Pinned;

const PINNED: { id: Pinned; label: string; icon: IconName }[] = [
  { id: 'stacks', label: 'Tasks', icon: 'overview' },
  { id: 'canvas', label: 'Canvas', icon: 'canvas' },
  { id: 'code', label: 'Code', icon: 'code' },
  { id: 'map', label: 'Map', icon: 'grid' },
];

/** The step a thread is at: follow the newest child, staying on the same branch when it goes on. */
export function tipFrom(nodes: Record<string, CanvasNode>, id: string): TurnNode {
  let cur = nodes[id] as TurnNode;
  for (;;) {
    const kids = childrenOf(nodes, cur.id);
    if (!kids.length) return cur;
    cur = kids.find((k) => k.branchId === cur.branchId) ?? kids[kids.length - 1];
  }
}

export function rootOf(nodes: Record<string, CanvasNode>, id: string) {
  return pathTo(nodes, id)[0];
}

// ---------------- the bar along the top: a tab per task ----------------

const urgentStage = (s: Stage) => s === 'needs' || s === 'error' || s === 'failing' || s === 'feedback';
export const isFinished = (t: ThreadRow) => !!t.root.completed || t.stage === 'done' || t.stage === 'merged';

export type StatusKind = 'needs' | 'failed' | 'working' | 'ready' | 'idle' | 'kept' | 'done' | 'discarded';

/** One status for a task, for its icon. */
export function statusKind(t: ThreadRow): StatusKind {
  if (t.root.completed) return t.root.discarded ? 'discarded' : t.root.kept ? 'kept' : 'done';
  if (t.stage === 'needs' || t.stage === 'feedback') return 'needs';
  if (t.stage === 'error' || t.stage === 'failing') return 'failed';
  if (t.stage === 'working' || t.stage === 'checking') return 'working';
  if (t.stage === 'merged' || t.stage === 'done') return 'done';
  return 'ready';
}

/** A small status mark, the same everywhere: a ring when ready, a half circle while working, a check when kept. */
export function StatusIcon({ kind, size = 14, fresh = false }: { kind: StatusKind; size?: number; fresh?: boolean }) {
  const c = 7;
  const body = (() => {
    switch (kind) {
      case 'working':
        return (
          <>
            <circle cx={c} cy={c} r={5.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
            <path d={`M${c} ${c} L${c} 3.5 A3.5 3.5 0 0 1 ${c} 10.5 Z`} fill="currentColor" />
          </>
        );
      case 'ready':
        return (
          <>
            <circle cx={c} cy={c} r={5.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
            <path d={`M${c} ${c} L${c} 3.5 A3.5 3.5 0 1 1 3.5 ${c} Z`} fill="currentColor" />
          </>
        );
      case 'needs':
        return (
          <>
            <circle cx={c} cy={c} r={6.5} fill="currentColor" />
            <path d="M7 3.8v3.9" stroke="var(--si-fg)" strokeWidth={1.6} strokeLinecap="round" />
            <circle cx={7} cy={10} r={0.95} fill="var(--si-fg)" />
          </>
        );
      case 'failed':
      case 'discarded':
        return (
          <>
            <circle cx={c} cy={c} r={6.5} fill="currentColor" />
            <path d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2" stroke="var(--si-fg)" strokeWidth={1.5} strokeLinecap="round" />
          </>
        );
      case 'kept':
      case 'done':
        return (
          <>
            <circle cx={c} cy={c} r={6.5} fill="currentColor" />
            <path d="M4.3 7.2l1.8 1.8 3.6-3.8" fill="none" stroke="var(--si-fg)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
          </>
        );
      default:
        return <circle cx={c} cy={c} r={5.5} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2.2 2" />;
    }
  })();
  return (
    <span className={`si si-${kind} ${fresh ? 'fresh' : ''}`} style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 14 14" width={size} height={size}>
        {body}
      </svg>
    </span>
  );
}

/** What a task's tab says under its title. */
export function taskWord(t: ThreadRow) {
  if (t.root.completed && t.root.discarded) return 'Discarded';
  if (t.root.completed && t.root.kept) return t.root.kept.mode === 'commit' ? `Kept · ${t.root.kept.commit ?? 'committed'}` : 'Kept in your folder';
  if (t.stage === 'working' || t.stage === 'checking') return `${STAGE_LABEL[t.stage]}…`;
  if (t.stage === 'idle' || t.stage === 'review') return 'Ready to review';
  return STAGE_LABEL[t.stage];
}
/** A tab worth a beacon when it's scrolled out of sight: it needs you, or it just finished. */
const alertOf = (t: ThreadRow, ready: Set<string>, nodes: Record<string, CanvasNode>): 'needs' | 'ready' | null => {
  if (isFinished(t)) return null;
  if (urgentStage(t.stage)) return 'needs';
  if (t.stage === 'working' || t.stage === 'checking') return null;
  return Object.values(nodes).some((n) => isTurn(n) && ready.has(n.id) && rootOf(nodes, n.id)?.id === t.root.id) ? 'ready' : null;
};

// Finished tasks you opened from History stay open as tabs until you close them. Kept per board,
// in this browser.
const TABS_KEY = 'forkspace:open-tabs';
const loadTabs = (): Record<string, string[]> => {
  try {
    return JSON.parse(localStorage.getItem(TABS_KEY) || '{}');
  } catch {
    return {};
  }
};

export function TaskTabs({
  board,
  currentRootId,
  view,
  onPick,
  onNew,
  onView,
  onSearch,
}: {
  board: Board;
  currentRootId: string | null;
  view: ActiveTab | '';
  onPick: (root: TurnNode) => void;
  onNew: () => void;
  onView: (v: ActiveTab) => void;
  onSearch: () => void;
}) {
  useTick();
  const { nodes, branches, boards } = useStore();
  const ready = useReady();
  const threads = useMemo(() => threadsOf(nodes, branches, boards, ready, board.id), [nodes, branches, boards, ready, board.id]);
  const [kept, setKept] = useState(loadTabs);
  const extra = (kept[board.id] ?? []).filter((id) => threads.some((t) => t.root.id === id && isFinished(t)));
  const setExtra = (fn: (ids: string[]) => string[]) =>
    setKept((all) => {
      const next = { ...all, [board.id]: fn(all[board.id] ?? []) };
      try {
        localStorage.setItem(TABS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  // A task that finishes while its tab is open keeps its tab, like any page you have open.
  const current = threads.find((t) => t.root.id === currentRootId);
  const currentDone = !!current && isFinished(current);
  useEffect(() => {
    if (currentDone && currentRootId && !extra.includes(currentRootId)) setExtra((ids) => [...ids, currentRootId]);
  }, [currentDone, currentRootId]);
  // Tabs keep their place, like a browser's: live tasks oldest first, then finished ones in the
  // order you opened them.
  const live = threads.filter((t) => !isFinished(t)).sort((a, b) => a.root.createdAt - b.root.createdAt);
  const openDone = extra.map((id) => threads.find((t) => t.root.id === id)!).filter(Boolean);
  const open = [...live, ...openDone, ...(current && isFinished(current) && !extra.includes(current.root.id) ? [current] : [])];
  const history = threads.filter(isFinished).sort((a, b) => (b.root.discarded ?? b.root.kept?.at ?? b.at) - (a.root.discarded ?? a.root.kept?.at ?? a.at));
  const alerts = new Map(open.map((t) => [t.root.id, alertOf(t, ready, nodes)]));
  const strip = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<{ left: string[]; right: string[] }>({ left: [], right: [] });
  const [histAt, setHistAt] = useState<{ x: number; y: number } | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; t: ThreadRow } | null>(null);
  const [tagging, setTagging] = useState<{ x: number; y: number; t: ThreadRow } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const measure = () => {
    const el = strip.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const left: string[] = [];
    const right: string[] = [];
    el.querySelectorAll<HTMLElement>('.tk[data-alert]').forEach((b) => {
      const r = b.getBoundingClientRect();
      // Even half hidden counts: the beacon is what says it's there.
      if (r.left < box.left - 8) left.push(b.dataset.id!);
      else if (r.right > box.right + 8) right.push(b.dataset.id!);
    });
    setEdges((e) => (e.left.join() === left.join() && e.right.join() === right.join() ? e : { left, right }));
  };
  const alertKey = open.map((t) => `${t.root.id}:${alerts.get(t.root.id) ?? ''}`).join();
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [alertKey]);
  useEffect(() => {
    const el = strip.current?.querySelector('.tk.on') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [currentRootId]);
  // ← → move between tasks, like switching browser tabs.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.metaKey || e.ctrlKey || e.altKey || view !== 'stacks') return;
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable], .cm-editor, .xterm')) return;
      const at = open.findIndex((t) => t.root.id === currentRootId);
      const next = open[e.key === 'ArrowRight' ? Math.min(open.length - 1, at + 1) : Math.max(0, at - 1)];
      if (next && next.root.id !== currentRootId) (e.preventDefault(), onPick(tipFrom(nodes, next.root.id)));
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });
  // Turns the wheel into sideways scrolling, so a mouse can move along the tabs.
  const onWheel = (e: React.WheelEvent) => {
    if (strip.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current.scrollLeft += e.deltaY;
  };
  const show = (ids: string[]) => {
    const el = strip.current?.querySelector(`.tk[data-id="${ids[0]}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  };
  const beacon = (side: 'left' | 'right') => {
    const ids = edges[side];
    if (!ids.length) return null;
    const needs = ids.filter((id) => alerts.get(id) === 'needs');
    const fresh = ids.length - needs.length;
    const list = needs.length ? needs : ids;
    const text = [needs.length ? `${needs.length} need${needs.length === 1 ? 's' : ''} you` : '', fresh ? `${fresh} ready` : ''].filter(Boolean).join(' · ');
    return (
      <div className={`tk-edge ${side}`}>
        <button className={`tk-beacon ${needs.length ? 'needs' : 'ready'}`} onClick={() => show(list)} title={`Show ${needs.length ? 'what needs you' : 'what finished'}`}>
          {side === 'left' && <Icon name="chevronLeft" size={12} />}
          <span className="tk-pulse" />
          {text}
          {side === 'right' && <Icon name="chevronRight" size={12} />}
        </button>
      </div>
    );
  };
  // Closing a tab: a finished task just leaves the tabs (it's in History); a live one is marked
  // done first. Either way, the tab next to it opens.
  const close = (t: ThreadRow) => {
    const at = open.findIndex((x) => x.root.id === t.root.id);
    const rest = open.filter((x) => x.root.id !== t.root.id);
    setExtra((ids) => ids.filter((id) => id !== t.root.id));
    if (!isFinished(t)) {
      send({ type: 'setCompleted', nodeId: t.root.id, completed: true });
      toast('Marked done. It’s in History.');
    }
    if (t.root.id === currentRootId) {
      const next = rest[Math.min(at, rest.length - 1)];
      if (next) onPick(tipFrom(nodes, next.root.id));
      else onNew();
    }
  };
  // Right-click a tab: what a browser tab offers, plus what a task can do.
  const menuFor = (t: ThreadRow): MenuItem[] => {
    const done = isFinished(t);
    const finishedOpen = open.filter((x) => isFinished(x) && x.root.id !== t.root.id);
    return [
      { label: 'Tags…', icon: 'tag', onClick: () => setTagging({ x: tabMenu?.x ?? 200, y: tabMenu?.y ?? 60, t }) },
      { label: 'Rename', icon: 'note', onClick: () => setRenaming(t.root.id) },
      { label: 'Copy title', icon: 'copy', onClick: () => navigator.clipboard?.writeText(t.title).then(() => toast('Title copied'), () => toast('Could not copy', 'error')) },
      'sep',
      ...(done
        ? [{ label: 'Reopen', icon: 'refresh' as const, onClick: () => send({ type: 'setCompleted', nodeId: t.root.id, completed: false }) }]
        : [
            { label: 'Mark done', icon: 'check' as const, onClick: () => send({ type: 'setCompleted', nodeId: t.root.id, completed: true }) },
            {
              label: 'Discard',
              icon: 'trash' as const,
              danger: true,
              onClick: () => (send({ type: 'setDiscarded', nodeId: t.root.id, discarded: true }), toast('Discarded. It’s in History.')),
            },
          ]),
      'sep',
      { label: 'Close tab', icon: 'x', hint: done ? undefined : 'marks it done', onClick: () => close(t) },
      ...(finishedOpen.length
        ? [
            {
              label: `Close finished tabs (${finishedOpen.length})`,
              icon: 'x' as const,
              onClick: () => {
                const ids = new Set(finishedOpen.map((x) => x.root.id));
                setExtra((list) => list.filter((id) => !ids.has(id)));
                if (currentRootId && ids.has(currentRootId)) onPick(tipFrom(nodes, t.root.id));
              },
            },
          ]
        : []),
    ];
  };
  const rename = (t: ThreadRow, title: string) => {
    setRenaming(null);
    if (title.trim() && title.trim() !== t.title) send({ type: 'setTitle', nodeId: t.root.id, title: title.trim() });
  };
  const openFromHistory = (t: ThreadRow) => {
    if (!extra.includes(t.root.id)) setExtra((ids) => [...ids, t.root.id]);
    onPick(tipFrom(nodes, t.root.id));
  };
  return (
    <header className="ws-tabs tk-bar">
      <div className="tk-wrap">
        {beacon('left')}
        <div className="tk-strip" ref={strip} onScroll={measure} onWheel={onWheel} role="tablist" aria-label="Tasks">
          {open.map((t) => {
            const on = view === 'stacks' && t.root.id === currentRootId;
            const alert = alerts.get(t.root.id);
            const tags = tagsOf(board, t.root);
            return (
              <div
                key={t.root.id}
                className={`tk ${on ? 'on' : ''} stage-${t.stage} ${isFinished(t) ? 'done' : ''} ${t.root.discarded ? 'discarded' : ''} ${tags.length ? 'tagged' : ''}`}
                data-id={t.root.id}
                data-alert={alert ?? undefined}
              >
                <TagBand tags={tags} />
                <button
                  className="tk-main"
                  role="tab"
                  aria-selected={on}
                  onClick={() => renaming !== t.root.id && onPick(tipFrom(nodes, t.root.id))}
                  onContextMenu={(e) => (e.preventDefault(), setTabMenu({ x: e.clientX, y: e.clientY, t }))}
                  onAuxClick={(e) => e.button === 1 && isFinished(t) && close(t)}
                  title={`${t.title}\n${taskWord(t)}${tags.length ? `\nTags: ${tags.map((x) => x.name).join(', ')}` : ''}${t.root.memo ? `\n\nNote: ${t.root.memo.slice(0, 200)}` : ''}`}
                >
                  <span className="tk-title">
                    <StatusIcon kind={statusKind(t)} size={13} fresh={alert === 'ready'} />
                    {renaming === t.root.id ? (
                      <input
                        className="tk-rename"
                        defaultValue={t.title}
                        autoFocus
                        onFocus={(e) => e.currentTarget.select()}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') rename(t, e.currentTarget.value);
                          if (e.key === 'Escape') setRenaming(null);
                        }}
                        onBlur={(e) => rename(t, e.currentTarget.value)}
                        aria-label="Task name"
                      />
                    ) : (
                      <span className="ellipsis">{t.title}</span>
                    )}
                  </span>
                </button>
                <button className="tk-x" onClick={() => close(t)} title={isFinished(t) ? 'Close tab (it stays in History)' : 'Mark done and close'} aria-label={`Close ${t.title}`}>
                  <Icon name="x" size={11} />
                </button>
              </div>
            );
          })}
          <button className="tk-new" onClick={onNew} title="New task" aria-label="New task">
            <Icon name="plus" size={15} />
          </button>
        </div>
        {beacon('right')}
      </div>
      <div className="tk-tools">
        <button
          className={`tk-tool ${histAt ? 'on' : ''}`}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHistAt(histAt ? null : { x: Math.max(8, r.right - 380), y: r.bottom + 6 });
          }}
          title="Finished and discarded tasks"
        >
          <Icon name="clock" size={14} /> History{history.length ? <span className="tk-count">{history.length}</span> : null}
        </button>
        <span className="tk-sep" />
        {PINNED.map((p, i) => (
          <button key={p.id} className={`tk-tool icon ${view === p.id ? 'on' : ''}`} onClick={() => onView(p.id)} title={`${p.label} (${i + 1})`} aria-label={p.label}>
            <Icon name={p.icon} size={15} />
          </button>
        ))}
        <button className="tk-tool icon" onClick={onSearch} title="Search everything (⌘K)" aria-label="Search">
          <Icon name="search" size={15} />
        </button>
      </div>
      {tagging && <TagPicker board={board} root={tagging.t.root} x={tagging.x} y={tagging.y} onClose={() => setTagging(null)} />}
      {tabMenu && <ContextMenu x={tabMenu.x} y={tabMenu.y} items={menuFor(tabMenu.t)} onClose={() => setTabMenu(null)} />}
      {histAt && <HistoryPanel at={histAt} rows={history} openIds={new Set(open.map((t) => t.root.id))} onOpen={openFromHistory} onClose={() => setHistAt(null)} />}
    </header>
  );
}

/**
 * Every finished task: kept, done or discarded. Click as many as you like; each opens as a tab and
 * the list stays put. Reopen puts one back to work; Delete for good is the only real delete.
 */
function HistoryPanel({ at, rows, openIds, onOpen, onClose }: { at: { x: number; y: number }; rows: ThreadRow[]; openIds: Set<string>; onOpen: (t: ThreadRow) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.tk-tool') && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('mousedown', down);
    addEventListener('keydown', key);
    return () => (removeEventListener('mousedown', down), removeEventListener('keydown', key));
  }, []);
  const shown = rows.filter((t) => !q.trim() || t.title.toLowerCase().includes(q.trim().toLowerCase()));
  const when = (t: ThreadRow) => timeAgo(t.root.discarded ?? t.root.kept?.at ?? t.at);
  const forget = (t: ThreadRow) => {
    if (!confirm(`Delete “${t.title}” for good?\n\nIts steps and its copy of the code are removed. This can’t be undone.`)) return;
    send({ type: 'deleteNodes', ids: [t.root.id] });
  };
  return (
    <div className="hp" ref={box} style={{ left: at.x, top: at.y }} role="dialog" aria-label="History">
      <div className="hp-head">
        <b>History</b>
        <span>{rows.length} finished</span>
      </div>
      {rows.length > 6 && (
        <div className="hp-find">
          <Icon name="search" size={13} />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a task" />
        </div>
      )}
      <div className="hp-list">
        {!shown.length && <div className="hp-empty">{rows.length ? 'Nothing matches.' : 'Tasks you keep, finish or discard land here.'}</div>}
        {shown.map((t) => (
          <div key={t.root.id} className={`hp-row ${t.root.discarded ? 'discarded' : t.root.kept ? 'kept' : ''}`}>
            <button className="hp-main" onClick={() => onOpen(t)} title="Open as a tab">
              <StatusIcon kind={statusKind(t)} size={15} />
              <span className="hp-text">
                <span className="hp-title">{t.title}</span>
                <span className="hp-sub">
                  {taskWord(t)} · {when(t)}
                </span>
              </span>
              {openIds.has(t.root.id) && <span className="hp-open">open</span>}
            </button>
            <button className="hp-act" onClick={() => send({ type: 'setCompleted', nodeId: t.root.id, completed: false })} title="Reopen: put it back with your tasks">
              <Icon name="refresh" size={13} />
            </button>
            <button className="hp-act danger" onClick={() => forget(t)} title="Delete for good">
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="hp-foot">Click to open as a tab. Open as many as you like.</div>
    </div>
  );
}

// ---------------- the status bar along the bottom ----------------

export function Dock({
  board,
  boards,
  page,
  counts,
  agents,
  termOpen,
  onBoard,
  onNewBoard,
  onBoardSettings,
  onPage,
  onAgent,
  onTerminal,
  onSettings,
  extra,
}: {
  board: Board | null;
  boards: Board[];
  page: string;
  counts: { work: number; notes: number; concepts: number };
  agents: TurnNode[];
  termOpen: boolean;
  onBoard: (id: string) => void;
  onNewBoard: () => void;
  onBoardSettings: () => void;
  onPage: (p: 'work' | 'notes' | 'concepts') => void;
  onAgent: (t: TurnNode) => void;
  onTerminal: () => void;
  onSettings: () => void;
  extra?: ReactNode;
}) {
  const { nodes, connected } = useStore();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const waiting = agents.filter((a) => a.status === 'waiting');
  const at = (e: React.MouseEvent, items: MenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.top - 6, items });
  };
  const boardItems = (): MenuItem[] => [
    ...boards.map((b) => {
      const live = Object.values(nodes).filter((n): n is TurnNode => isTurn(n) && n.boardId === b.id && isLive(n)).length;
      return { label: b.name, icon: (b.id === board?.id ? 'check' : 'folder') as IconName, hint: live ? `${live} live` : undefined, onClick: () => onBoard(b.id) };
    }),
    'sep',
    { label: 'New board', icon: 'plus', onClick: onNewBoard },
    ...(board ? [{ label: 'Board settings', icon: 'settings' as const, onClick: onBoardSettings }] : []),
  ];
  const agentItems = (): MenuItem[] => agents.map((t) => ({ label: rootOf(nodes, t.id)?.title || t.prompt, icon: (t.status === 'waiting' ? 'bell' : 'spark') as IconName, hint: t.status === 'waiting' ? 'Needs you' : 'Working', onClick: () => onAgent(t) }));
  return (
    <footer className="dock">
      {menu && <ContextMenu x={menu.x} y={menu.y} above items={menu.items} onClose={() => setMenu(null)} />}
      <button className="dock-btn dock-board" onClick={(e) => at(e, boardItems())} title={board ? board.cwd : 'Boards'}>
        <span className={`conn ${connected ? 'on' : ''}`} />
        <b>{board?.name ?? 'Forkspace'}</b>
        <Icon name="chevronUp" size={12} />
      </button>
      {board?.permissionMode === 'bypassPermissions' && (
        <button className="dock-btn danger" onClick={onBoardSettings} title="Agents never ask before acting. Click to change">
          <Icon name="shield" size={12} /> Full access
        </button>
      )}
      <span className="dock-sep" />
      {(
        [
          ['work', 'Work', counts.work, 'inbox'],
          ['notes', 'Notes', counts.notes, 'folder'],
          ['concepts', 'Concepts', counts.concepts, 'bookmark'],
        ] as const
      ).map(([id, label, n, icon]) => (
        <button key={id} className={`dock-btn ${page === id ? 'on' : ''}`} onClick={() => onPage(id)}>
          <Icon name={icon} size={13} /> {label}
          {n > 0 && <span className={`dock-count ${id === 'work' ? 'warn' : ''}`}>{n}</span>}
        </button>
      ))}
      {agents.length > 0 && (
        <>
          <span className="dock-sep" />
          <button className={`dock-btn dock-agents ${waiting.length ? 'warn' : ''}`} onClick={(e) => at(e, agentItems())}>
            <span className="dock-pulse" />
            {waiting.length ? `${waiting.length} need${waiting.length === 1 ? 's' : ''} you` : `${agents.length} working`}
          </button>
        </>
      )}
      <span className="spacer" />
      {extra}
      <button className={`dock-btn ${termOpen ? 'on' : ''}`} onClick={onTerminal} title="Terminal (Ctrl+`)">
        <Icon name="terminal" size={13} /> Terminal
      </button>
      <button className="dock-btn" onClick={onSettings} title="Settings" aria-label="Settings">
        <Icon name="settings" size={13} />
      </button>
    </footer>
  );
}
