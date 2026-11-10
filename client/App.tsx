import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Board, TurnNode } from '../shared/types.ts';
import { BoardSettings, MODES, NewBoard } from './BoardForms.tsx';
import { Canvas } from './Canvas.tsx';
import { Chat } from './Chat.tsx';
import { Composer, composerFocus } from './Composer.tsx';
import { Drawer } from './Drawer.tsx';
import { PairScreen, Splash, UnreachableScreen } from './Gate.tsx';
import { Icon } from './icons.tsx';
import { Inbox, SidebarAgents, useAgents } from './Inbox.tsx';
import { placeFor } from './layout.ts';
import { useInstall } from './pwa.ts';
import { Settings } from './Settings.tsx';
import { request, toast, useStore } from './store.ts';
import { isLive, isTurn, latestLeaf, leaves } from './tree.ts';
import { Segmented, Sheet, useIsMobile } from './ui.tsx';

type View = 'chat' | 'canvas';
type Tab = 'board' | 'agents' | 'devices';

const ls = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export default function App() {
  const { auth, loaded } = useStore();
  if (auth === 'pairing') return <PairScreen />;
  if (auth === 'unreachable' && !loaded) return <UnreachableScreen />;
  if (!loaded) return <Splash />;
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  );
}

function Shell() {
  const store = useStore();
  const mobile = useIsMobile();
  const [boardId, setBoardId] = useState<string | null>(ls.get('forkspace:board'));
  const [views, setViews] = useState<Record<string, View>>(() => {
    try {
      return JSON.parse(ls.get('forkspace:views') || '{}');
    } catch {
      return {};
    }
  });
  const [targets, setTargets] = useState<Record<string, string | null>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [sheet, setSheet] = useState<null | 'new' | 'board' | 'devices' | 'boards'>(null);
  const [tab, setTab] = useState<Tab>('board');
  const { waiting, running } = useAgents();

  const board = store.boards.find((b) => b.id === boardId) ?? store.boards[0] ?? null;
  const view: View = (board && views[board.id]) || (mobile ? 'chat' : 'canvas');
  const targetId = board ? (targets[board.id] ?? null) : null;
  const target = targetId && isTurn(store.nodes[targetId]) ? (store.nodes[targetId] as TurnNode) : undefined;

  useEffect(() => {
    if (board) ls.set('forkspace:board', board.id);
  }, [board?.id]);
  useEffect(() => ls.set('forkspace:views', JSON.stringify(views)), [views]);
  useEffect(() => {
    document.title = waiting.length ? `(${waiting.length}) Forkspace` : running.length ? '● Forkspace' : 'Forkspace';
    const nav = navigator as any;
    if (nav.setAppBadge) (waiting.length ? nav.setAppBadge(waiting.length) : nav.clearAppBadge()).catch(() => {});
  }, [waiting.length, running.length]);

  const setTargetId = useCallback(
    (id: string | null) => {
      if (board) setTargets((t) => ({ ...t, [board.id]: id }));
    },
    [board?.id],
  );

  // Open each board where you left off: its most recent branch tip.
  useEffect(() => {
    if (!board || board.id in targets) return;
    const tip = leaves(store.nodes, board.id)[0];
    setTargets((t) => ({ ...t, [board.id]: tip?.id ?? null }));
  }, [board?.id, store.nodes]);

  // Forget targets / details whose card was deleted (only after we have seen it exist).
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const id of Object.keys(store.nodes)) seen.current.add(id);
    const gone = (id?: string | null) => !!id && seen.current.has(id) && !store.nodes[id];
    if (Object.values(targets).some(gone)) setTargets((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, gone(v) ? null : v])));
    if (gone(openId)) setOpenId(null);
  }, [store.nodes]);

  const goTo = useCallback(
    (t: TurnNode) => {
      setBoardId(t.boardId);
      const dest = isLive(t) ? t.id : latestLeaf(store.nodes, t.id).id;
      setTargets((x) => ({ ...x, [t.boardId]: dest }));
      setTab('board');
      setFocus({ id: dest, n: Date.now() });
    },
    [store.nodes],
  );

  // Deep links: ?board=…&node=… (notification taps).
  const openUrl = useCallback(
    (href: string) => {
      const u = new URL(href, location.origin);
      const node = u.searchParams.get('node');
      const b = u.searchParams.get('board');
      if (b) setBoardId(b);
      if (node && isTurn(store.nodes[node])) goTo(store.nodes[node] as TurnNode);
    },
    [store.nodes, goTo],
  );
  useEffect(() => {
    if (location.search.includes('node=')) {
      openUrl(location.href);
      history.replaceState(null, '', '/');
    }
    const onMsg = (e: MessageEvent) => e.data?.type === 'open' && openUrl(e.data.url);
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, [openUrl]);

  // Global shortcuts.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' || e.key === 'r') {
        e.preventDefault();
        composerFocus.current?.focus();
      }
      if (e.key === 'Escape' && !openId && !sheet) setTargetId(null);
      if (board && (e.key === '1' || e.key === '2')) setViews((v) => ({ ...v, [board.id]: e.key === '1' ? 'chat' : 'canvas' }));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [openId, sheet, board?.id, setTargetId]);

  const submit = async (prompt: string) => {
    if (!board) return false;
    const position = placeFor(store.nodes, board.id, targetId, { x: 0, y: 0 });
    try {
      const { id } = await request<{ id: string }>({ type: 'send', boardId: board.id, parentId: targetId, prompt, position });
      setTargetId(id);
      setFocus({ id, n: Date.now() });
      return true;
    } catch (err: any) {
      toast(err.message, 'error');
      return false;
    }
  };

  const setView = (v: View) => board && setViews((x) => ({ ...x, [board.id]: v }));
  const openNode = openId && isTurn(store.nodes[openId]) ? (store.nodes[openId] as TurnNode) : null;

  const boardView = board ? (
    <>
      <div className="view">
        {view === 'canvas' ? (
          <Canvas board={board} targetId={targetId} setTargetId={setTargetId} openDetails={setOpenId} focus={focus} />
        ) : (
          <Chat board={board} targetId={targetId} setTargetId={setTargetId} openDetails={setOpenId} />
        )}
      </div>
      <Composer key={board.id} target={target} board={board} onSubmit={submit} onClear={() => setTargetId(null)} />
    </>
  ) : (
    <Welcome onNew={() => setSheet('new')} />
  );

  const viewSwitch = board && (
    <Segmented
      value={view}
      onChange={setView}
      options={[
        {
          value: 'chat',
          label: (
            <>
              <Icon name="chat" size={14} />
              {!mobile && 'Chat'}
            </>
          ),
        },
        {
          value: 'canvas',
          label: (
            <>
              <Icon name="canvas" size={14} />
              {!mobile && 'Canvas'}
            </>
          ),
        },
      ]}
    />
  );

  const sheets = (
    <>
      {sheet === 'new' && (
        <NewBoard
          onClose={() => setSheet(null)}
          onCreated={(b) => {
            setBoardId(b.id);
            setSheet(null);
            setTab('board');
          }}
        />
      )}
      {sheet === 'board' && board && <BoardSettings board={board} onClose={() => setSheet(null)} />}
      {sheet === 'devices' && (
        <Sheet title="Devices" onClose={() => setSheet(null)} wide>
          <Settings />
        </Sheet>
      )}
      {sheet === 'boards' && (
        <Sheet title="Boards" onClose={() => setSheet(null)}>
          <BoardList
            boards={store.boards}
            current={board?.id}
            onPick={(id) => {
              setBoardId(id);
              setSheet(null);
            }}
            onNew={() => setSheet('new')}
          />
        </Sheet>
      )}
      <Toasts />
    </>
  );

  // ---------------- phone ----------------
  if (mobile) {
    return (
      <div className="app mobile">
        <ConnectionBanner />
        {tab === 'board' && (
          <header className="m-top">
            {board ? (
              <button className="m-board" onClick={() => setSheet('boards')}>
                <span className="board-initial">{board.name.slice(0, 1).toUpperCase()}</span>
                <span className="ellipsis">{board.name}</span>
                <Icon name="chevronDown" size={14} />
              </button>
            ) : (
              <span className="m-board">Forkspace</span>
            )}
            <span className="spacer" />
            {viewSwitch}
            {board && (
              <button className="icon-btn" onClick={() => setSheet('board')} aria-label="Board settings">
                <Icon name="more" size={20} strokeWidth={2.75} />
              </button>
            )}
          </header>
        )}
        <main className="m-main">
          {tab === 'board' && boardView}
          {tab === 'agents' && <Inbox onOpen={goTo} />}
          {tab === 'devices' && (
            <div className="page">
              <div className="page-inner">
                <h1 className="page-title">Devices</h1>
                <Settings />
              </div>
            </div>
          )}
        </main>
        <nav className="tabbar">
          <button className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>
            <Icon name="branch" size={22} />
            <span>Board</span>
          </button>
          <button className={tab === 'agents' ? 'on' : ''} onClick={() => setTab('agents')}>
            <span className="tab-icon">
              <Icon name="inbox" size={22} />
              {waiting.length + running.length > 0 && <span className={`tab-badge ${waiting.length ? 'warn' : ''}`}>{waiting.length || running.length}</span>}
            </span>
            <span>Agents</span>
          </button>
          <button className={tab === 'devices' ? 'on' : ''} onClick={() => setTab('devices')}>
            <Icon name="phone" size={22} />
            <span>Devices</span>
          </button>
        </nav>
        {openNode && <Drawer node={openNode} onClose={() => setOpenId(null)} />}
        {sheets}
      </div>
    );
  }

  // ---------------- desktop ----------------
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="app-mark">
            <Icon name="branch" size={15} strokeWidth={2.25} />
          </div>
          <span>Forkspace</span>
          <ConnDot />
        </div>

        <div className="side-scroll">
          <div className="side-head">
            <span>Boards</span>
            <button className="icon-btn sm" onClick={() => setSheet('new')} aria-label="New board" title="New board">
              <Icon name="plus" size={15} />
            </button>
          </div>
          <BoardList
            boards={store.boards}
            current={board?.id}
            onPick={(id) => {
              setBoardId(id);
              setOpenId(null);
            }}
          />

          <div className="side-head">
            <span>Agents</span>
            {waiting.length > 0 && <span className="pill warn">{waiting.length} need you</span>}
          </div>
          <SidebarAgents onOpen={goTo} />
        </div>

        <div className="side-foot">
          <InstallButton />
          <button className="side-link" onClick={() => setSheet('devices')}>
            <Icon name="phone" size={15} /> Devices & phone
          </button>
        </div>
      </aside>

      <main className="main">
        <ConnectionBanner />
        {board && (
          <header className="topbar">
            <button className="board-title" onClick={() => setSheet('board')} title="Board settings">
              {board.name}
              <Icon name="chevronDown" size={14} />
            </button>
            <span className="path mono" title={board.cwd}>
              {store.home ? board.cwd.replace(store.home, '~') : board.cwd}
            </span>
            <button className={`pill mode ${board.permissionMode === 'bypassPermissions' ? 'danger' : ''}`} onClick={() => setSheet('board')} title="Permissions">
              <Icon name="shield" size={12} />
              {MODES.find((m) => m.value === board.permissionMode)?.label}
            </button>
            <span className="spacer" />
            {viewSwitch}
          </header>
        )}
        <div className="main-body">{boardView}</div>
      </main>

      {openNode && <Drawer node={openNode} onClose={() => setOpenId(null)} />}
      {sheets}
    </div>
  );
}

function BoardList({ boards, current, onPick, onNew }: { boards: Board[]; current?: string; onPick: (id: string) => void; onNew?: () => void }) {
  const { nodes } = useStore();
  return (
    <div className="board-list">
      {boards.map((b) => {
        const live = Object.values(nodes).filter((n): n is TurnNode => isTurn(n) && n.boardId === b.id && isLive(n));
        const needs = live.filter((n) => n.status === 'waiting').length;
        return (
          <button key={b.id} className={`board-item ${b.id === current ? 'on' : ''}`} onClick={() => onPick(b.id)}>
            <span className="board-initial">{b.name.slice(0, 1).toUpperCase()}</span>
            <span className="ellipsis">{b.name}</span>
            <span className="spacer" />
            {needs > 0 ? <span className="count warn">{needs}</span> : live.length > 0 ? <span className="count">{live.length}</span> : null}
          </button>
        );
      })}
      {boards.length === 0 && <div className="side-empty">No boards yet</div>}
      {onNew && (
        <button className="board-item add" onClick={onNew}>
          <span className="board-initial">
            <Icon name="plus" size={14} />
          </span>
          New board
        </button>
      )}
    </div>
  );
}

function Welcome({ onNew }: { onNew: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="app-mark big">
          <Icon name="branch" size={28} strokeWidth={2} />
        </div>
        <h1>All your agents, one place</h1>
        <p>Point a board at a project folder. Every prompt becomes a step you can return to. Branch from any step to try another idea, and the code branches with it.</p>
        <button className="btn primary lg" onClick={onNew}>
          <Icon name="plus" size={16} /> Create a board
        </button>
      </div>
    </div>
  );
}

function ConnDot() {
  const { connected } = useStore();
  return <span className={`conn ${connected ? 'on' : ''}`} title={connected ? 'Connected to your Mac' : 'Reconnecting…'} />;
}

function ConnectionBanner() {
  const { connected, loaded } = useStore();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (connected) return setShow(false);
    const t = setTimeout(() => setShow(true), 1200);
    return () => clearTimeout(t);
  }, [connected]);
  if (!show || !loaded) return null;
  return (
    <div className="conn-banner">
      <span className="spinner" /> Reconnecting to your Mac…
    </div>
  );
}

function InstallButton() {
  const { canPrompt, prompt } = useInstall();
  if (!canPrompt) return null;
  return (
    <button className="side-link accent" onClick={prompt}>
      <Icon name="download" size={15} /> Install app
    </button>
  );
}

function Toasts() {
  const { toasts } = useStore();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
