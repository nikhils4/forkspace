import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Board, CanvasNode, TurnNode } from '../shared/types.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
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

/** What a task's tab says under its title. */
export function taskWord(t: ThreadRow) {
  if (t.root.kept) return t.root.kept.mode === 'commit' ? `Kept · ${t.root.kept.commit ?? 'committed'}` : 'Kept in your folder';
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
  // Tabs keep their place, like a browser's: oldest on the left, new ones at the end.
  const open = threads.filter((t) => !isFinished(t) || t.root.id === currentRootId).sort((a, b) => a.root.createdAt - b.root.createdAt);
  const done = threads.filter((t) => isFinished(t) && t.root.id !== currentRootId);
  const alerts = new Map(open.map((t) => [t.root.id, alertOf(t, ready, nodes)]));
  const strip = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<{ left: string[]; right: string[] }>({ left: [], right: [] });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
  const close = (t: ThreadRow) => {
    send({ type: 'setCompleted', nodeId: t.root.id, completed: true });
    toast('Marked done. Find it under Done.');
  };
  const doneItems = (): MenuItem[] =>
    done.length
      ? done.slice(0, 30).map((t) => ({ label: t.title, icon: (t.root.kept ? 'check' : 'clock') as IconName, hint: timeAgo(t.at), onClick: () => onPick(tipFrom(nodes, t.root.id)) }))
      : [{ label: 'Nothing done yet', icon: 'check', disabled: true, onClick: () => {} }];
  return (
    <header className="ws-tabs tk-bar">
      <div className="tk-wrap">
        {beacon('left')}
        <div className="tk-strip" ref={strip} onScroll={measure} onWheel={onWheel} role="tablist" aria-label="Tasks">
          {open.map((t) => {
            const on = view === 'stacks' && t.root.id === currentRootId;
            const alert = alerts.get(t.root.id);
            return (
              <div key={t.root.id} className={`tk ${on ? 'on' : ''} stage-${t.stage} ${isFinished(t) ? 'done' : ''}`} data-id={t.root.id} data-alert={alert ?? undefined}>
                <button className="tk-main" role="tab" aria-selected={on} onClick={() => onPick(tipFrom(nodes, t.root.id))} title={t.title}>
                  <span className="tk-title">
                    <span className={`tk-dot ${alert ?? ''}`} />
                    <span className="ellipsis">{t.title}</span>
                  </span>
                  <span className="tk-word">{taskWord(t)}</span>
                </button>
                {!isFinished(t) && (
                  <button className="tk-x" onClick={() => close(t)} title="Mark done and close" aria-label={`Close ${t.title}`}>
                    <Icon name="x" size={11} />
                  </button>
                )}
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
          className="tk-tool"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 260, y: r.bottom + 6 });
          }}
          title="Finished tasks"
        >
          Done{done.length ? <span className="tk-count">{done.length}</span> : null}
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
      {menu && <ContextMenu x={menu.x} y={menu.y} items={doneItems()} onClose={() => setMenu(null)} />}
    </header>
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
