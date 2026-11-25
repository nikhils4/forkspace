import { useMemo, useState, type ReactNode } from 'react';
import type { Board, CanvasNode, TurnNode } from '../shared/types.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { Icon, type IconName } from './icons.tsx';
import { DiffStat, StatusDot, branchColor } from './nodes.tsx';
import { useReady } from './review.ts';
import { STAGE_LABEL, threadsOf, type Stage, type ThreadRow } from './status.ts';
import { useStore } from './store.ts';
import { PrBadge, StageChip, StageDot } from './Threads.tsx';
import { childrenOf, isLive, isTurn, lastText, pathTo, currentActivity } from './tree.ts';
import { timeAgo, useTick } from './ui.tsx';

// The desktop workspace, laid out like a browser: tabs along the top (the board's views, then
// every thread you opened), the page in the middle, and a status bar along the bottom.

export type Pinned = 'stacks' | 'canvas' | 'code' | 'map';
export type ActiveTab = Pinned | `t:${string}`;

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

const urgent = (s: Stage) => s === 'needs' || s === 'error' || s === 'failing' || s === 'feedback';
const busy = (s: Stage) => s === 'working' || s === 'checking';

// ---------------- tabs ----------------

export function TabStrip({ board, active, tabs, onPick, onClose, onNew, onSearch, left }: { board: Board; active: ActiveTab; tabs: string[]; onPick: (t: ActiveTab) => void; onClose: (rootId: string) => void; onNew: () => void; onSearch: () => void; left?: ReactNode }) {
  const { nodes, branches, boards } = useStore();
  const ready = useReady();
  const rows = useMemo(() => new Map(threadsOf(nodes, branches, boards, ready, board.id).map((t) => [t.root.id, t])), [nodes, branches, boards, ready, board.id]);
  return (
    <header className="ws-tabs">
      {left}
      <nav className="ws-pinned" aria-label="Views">
        {PINNED.map((p) => (
          <button key={p.id} className={`ws-pin ${active === p.id ? 'on' : ''}`} onClick={() => onPick(p.id)} title={p.label}>
            <Icon name={p.icon} size={14} />
            <span>{p.label}</span>
          </button>
        ))}
      </nav>
      {tabs.length > 0 && <span className="ws-sep" />}
      <div className="ws-open" role="tablist" aria-label="Open threads">
        {tabs.map((id) => {
          const t = rows.get(id);
          if (!t) return null;
          const on = active === `t:${id}`;
          return (
            <div
              key={id}
              role="tab"
              aria-selected={on}
              className={`ws-tab ${on ? 'on' : ''}`}
              title={`${t.title}\n${STAGE_LABEL[t.stage]}`}
              onClick={() => onPick(`t:${id}`)}
              onAuxClick={(e) => e.button === 1 && onClose(id)}
            >
              <StageDot stage={t.stage} />
              <span className="ws-tab-title">{t.title}</span>
              <button
                className="ws-tab-x"
                aria-label={`Close ${t.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(id);
                }}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          );
        })}
        <button className="ws-new" onClick={onNew} title="New thread" aria-label="New thread">
          <Icon name="plus" size={14} />
        </button>
      </div>
      <span className="spacer" />
      <button className="ws-search" onClick={onSearch} title="Search everything">
        <Icon name="search" size={13} />
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
    </header>
  );
}

// ---------------- the board's threads, as stacks of cards ----------------

export function Stacks({ board, onOpen, composer }: { board: Board; onOpen: (t: TurnNode) => void; composer: ReactNode }) {
  useTick();
  const { nodes, branches, boards } = useStore();
  const ready = useReady();
  const threads = useMemo(() => threadsOf(nodes, branches, boards, ready, board.id), [nodes, branches, boards, ready, board.id]);
  const [showDone, setShowDone] = useState(false);
  const finished = (t: ThreadRow) => t.root.completed || t.stage === 'done' || t.stage === 'merged';
  const groups: [string, ThreadRow[]][] = [
    ['Needs you', threads.filter((t) => !finished(t) && urgent(t.stage))],
    ['Working', threads.filter((t) => !finished(t) && busy(t.stage))],
    ['Open', threads.filter((t) => !finished(t) && !urgent(t.stage) && !busy(t.stage))],
  ];
  const done = threads.filter(finished);
  return (
    <div className="stacks">
      <div className="stacks-inner">
        <div className="stacks-compose">{composer}</div>
        {!threads.length && (
          <div className="stacks-empty">
            <b>No threads yet.</b>
            <span>Describe a task above. Each thread becomes a stack you can open, branch and close.</span>
          </div>
        )}
        {groups.map(([label, list]) =>
          list.length ? (
            <section key={label} className="stacks-group">
              <h2>
                {label} <span>{list.length}</span>
              </h2>
              <div className="stacks-grid">
                {list.map((t) => (
                  <Deck key={t.root.id} t={t} nodes={nodes} onOpen={onOpen} />
                ))}
              </div>
            </section>
          ) : null,
        )}
        {done.length > 0 && (
          <section className="stacks-group">
            <h2>
              <button className="stacks-fold" onClick={() => setShowDone(!showDone)}>
                <Icon name={showDone ? 'chevronDown' : 'chevronRight'} size={13} /> Done <span>{done.length}</span>
              </button>
            </h2>
            {showDone && (
              <div className="stacks-grid">
                {done.map((t) => (
                  <Deck key={t.root.id} t={t} nodes={nodes} onOpen={onOpen} />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function Deck({ t, nodes, onOpen }: { t: ThreadRow; nodes: Record<string, CanvasNode>; onOpen: (t: TurnNode) => void }) {
  const steps = t.branches.reduce((a, b) => a + b.steps, 0);
  const forks = t.branches.length - 1;
  const main = t.branches[0];
  const depth = Math.min(steps - 1, 2);
  const pr = t.branches.find((b) => b.branch?.pr)?.branch?.pr;
  const live = t.stage === 'working' || t.stage === 'needs';
  const tip = tipFrom(nodes, t.root.id);
  return (
    <button className={`deck d${depth} st-${t.stage} ${live ? 'live' : ''}`} onClick={() => onOpen(main.last)} style={{ ['--branch' as any]: branchColor(t.root.branchId) }}>
      <div className="deck-top">
        <StageChip stage={t.stage} small />
        <span className="spacer" />
        <span className="deck-when">{timeAgo(t.at)}</span>
      </div>
      <div className="deck-title">{t.title}</div>
      {t.now && <div className="deck-now">{t.now}</div>}
      <div className="deck-foot">
        <span>
          {steps} step{steps === 1 ? '' : 's'}
        </span>
        {forks > 0 && (
          <span className="deck-forks">
            <Icon name="branch" size={11} /> {forks + 1} branches
          </span>
        )}
        <span className="spacer" />
        {pr ? <PrBadge pr={pr} /> : <DiffStat s={tip.diffStat} />}
      </div>
    </button>
  );
}

// ---------------- one thread: its steps on the left, the chosen one on the right ----------------

export function ThreadView({ stepId, onSelect, detail }: { stepId: string; onSelect: (id: string) => void; detail: ReactNode }) {
  useTick();
  const { nodes, branches, boards } = useStore();
  const ready = useReady();
  const step = nodes[stepId] as TurnNode;
  const tip = tipFrom(nodes, stepId);
  const path = pathTo(nodes, tip.id);
  const root = path[0];
  const row = useMemo(() => threadsOf(nodes, branches, boards, ready, root.boardId).find((t) => t.root.id === root.id), [nodes, branches, boards, ready, root.id]);
  const [forkOpen, setForkOpen] = useState<string | null>(null);
  const title = root.title || root.prompt;

  return (
    <div className="tv">
      <aside className="tv-rail">
        <div className="tv-head">
          <div className="tv-title" title={title}>
            {title}
          </div>
          {row && (
            <div className="tv-meta">
              <StageChip stage={row.stage} small />
              <span>
                {path.length} step{path.length === 1 ? '' : 's'}
              </span>
            </div>
          )}
        </div>
        {row && row.branches.length > 1 && (
          <div className="tv-branches" aria-label="Branches">
            {row.branches.map((b) => {
              const on = b.branchId === tip.branchId;
              return (
                <button key={b.branchId} className={`tv-branch ${on ? 'on' : ''}`} onClick={() => onSelect(b.last.id)} style={{ ['--branch' as any]: branchColor(b.branchId) }} title={`${b.label} · ${STAGE_LABEL[b.stage]}`}>
                  <span className="tv-branch-bar" />
                  <span className="ellipsis">{b.label}</span>
                  <StageDot stage={b.stage} />
                </button>
              );
            })}
          </div>
        )}
        <ol className="tv-steps">
          {path.map((s, i) => {
            const kids = childrenOf(nodes, s.id);
            const others = kids.filter((k) => !path.includes(k));
            const on = s.id === step.id;
            const summary = isLive(s) ? currentActivity(s) : lastText(s) || s.error || '';
            return (
              <li key={s.id} className="tv-step-li">
                <button className={`tv-step ${on ? 'on' : ''} status-${s.status}`} onClick={() => onSelect(s.id)} style={{ ['--branch' as any]: branchColor(s.branchId) }}>
                  <div className="tv-step-top">
                    <span className="tv-num">{i + 1}</span>
                    <StatusDot status={s.status} />
                    <span className="spacer" />
                    <DiffStat s={s.diffStat} />
                    <span className="tv-when">{timeAgo(s.finishedAt ?? s.createdAt)}</span>
                  </div>
                  <div className="tv-prompt">{s.prompt}</div>
                  {summary && <div className="tv-sum">{summary}</div>}
                </button>
                {others.length > 0 && (
                  <div className="tv-fork">
                    <button className="tv-fork-btn" onClick={() => setForkOpen(forkOpen === s.id ? null : s.id)}>
                      <Icon name="branch" size={11} /> {others.length} other branch{others.length === 1 ? '' : 'es'} here
                    </button>
                    {forkOpen === s.id &&
                      others.map((k) => (
                        <button key={k.id} className="tv-fork-item" onClick={() => (setForkOpen(null), onSelect(tipFrom(nodes, k.id).id))} style={{ ['--branch' as any]: branchColor(k.branchId) }}>
                          <span className="tv-branch-bar" />
                          <span className="ellipsis">{k.title || k.prompt}</span>
                        </button>
                      ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </aside>
      <div className="tv-detail">{detail}</div>
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
