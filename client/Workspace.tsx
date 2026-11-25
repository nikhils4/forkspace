import { useState, type ReactNode } from 'react';
import type { Board, CanvasNode, TurnNode } from '../shared/types.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { Icon, type IconName } from './icons.tsx';
import { useStore } from './store.ts';
import { childrenOf, isLive, isTurn, pathTo } from './tree.ts';

// The desktop frame: the board's views along the top, the page in the middle, a status bar below.

export type Pinned = 'stacks' | 'canvas' | 'code' | 'map';
export type ActiveTab = Pinned;

const PINNED: { id: Pinned; label: string; icon: IconName }[] = [
  { id: 'stacks', label: 'Threads', icon: 'overview' },
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

// ---------------- the bar along the top ----------------

export function TabStrip({ active, onPick, onSearch }: { board: Board; active: ActiveTab; onPick: (t: ActiveTab) => void; onSearch: () => void }) {
  return (
    <header className="ws-tabs">
      <nav className="ws-pinned" aria-label="Views">
        {PINNED.map((p, i) => (
          <button key={p.id} className={`ws-pin ${active === p.id ? 'on' : ''}`} onClick={() => onPick(p.id)} title={`${p.label} (${i + 1})`}>
            <Icon name={p.icon} size={14} />
            <span>{p.label}</span>
          </button>
        ))}
      </nav>
      <span className="spacer" />
      <button className="ws-search" onClick={onSearch} title="Search everything">
        <Icon name="search" size={13} />
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
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
