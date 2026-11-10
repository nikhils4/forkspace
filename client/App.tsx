import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { conceptKey, type Board, type TurnNode } from '../shared/types.ts';
import { BoardSettings, MODES, NewBoard } from './BoardForms.tsx';
import { Canvas } from './Canvas.tsx';
import { Chat } from './Chat.tsx';
import { AwayLink, AwayScreen, goAway } from './Away.tsx';
import { bugReportUrl, ideaUrl } from './feedback.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { CodeView, fileCache } from './CodeView.tsx';
import { Composer, composerFocus } from './Composer.tsx';
import { Drawer } from './Drawer.tsx';
import { PairScreen, Splash, StartCommand, UnreachableScreen } from './Gate.tsx';
import { Icon } from './icons.tsx';
import { Inbox, SidebarAgents, useAgents } from './Inbox.tsx';
import { ImportSessions } from './Import.tsx';
import { LearnLibrary } from './Learn.tsx';
import { UpdatePill } from './Updates.tsx';
import { setTheme, useResolvedTheme } from './theme.ts';
import { placeFor } from './layout.ts';
import { useInstall } from './pwa.ts';
import { Palette, type PaletteItem } from './Palette.tsx';
import { Settings, settingsTab } from './Settings.tsx';
import { request, send, toast, useStore } from './store.ts';
import { branchColor, STATUS_LABEL } from './nodes.tsx';
import { isLive, isTurn, latestLeaf, leaves } from './tree.ts';
import { Segmented, Sheet, useIsMobile } from './ui.tsx';

type View = 'chat' | 'canvas' | 'code';
type Tab = 'board' | 'agents' | 'learn' | 'devices';

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
  const [sheet, setSheet] = useState<null | 'new' | 'board' | 'devices' | 'boards' | 'learn' | 'import'>(null);
  // Desktop: the main area shows a board, or the Concepts page.
  const [page, setPage] = useState<'board' | 'concepts'>('board');
  const [tab, setTab] = useState<Tab>('board');
  const [palette, setPalette] = useState(false);
  const [codeOpen, setCodeOpen] = useState<{ path: string; n: number } | null>(null);
  // Views are mounted on first visit and then kept alive, so switching never loses your place.
  const [visited, setVisited] = useState<Record<string, View[]>>({});
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p' && board) {
        e.preventDefault();
        setPalette(true);
        return;
      }
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable], .cm-editor')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' || e.key === 'r') {
        e.preventDefault();
        composerFocus.current?.focus();
      }
      if (e.key === 'Escape' && !openId && !sheet && page === 'concepts') return setPage('board');
      if (e.key === 'Escape' && !openId && !sheet) setTargetId(null);
      if (board && ['1', '2', '3'].includes(e.key)) {
        setPage('board');
        setViews((v) => ({ ...v, [board.id]: (['chat', 'canvas', 'code'] as const)[Number(e.key) - 1] }));
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [openId, sheet, board?.id, setTargetId, page]);

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
  useEffect(() => {
    if (board && !(visited[board.id] ?? []).includes(view)) setVisited((x) => ({ ...x, [board.id]: [...(x[board.id] ?? []), view] }));
  }, [board?.id, view]);
  const wasOpened = (v: View) => v === view || (board ? (visited[board.id] ?? []).includes(v) : false);
  const openNode = openId && isTurn(store.nodes[openId]) ? (store.nodes[openId] as TurnNode) : null;

  // Unique concepts: the same idea seen in several steps counts once.
  const lessonCount = useMemo(() => {
    const keys = new Set<string>();
    for (const x of Object.values(store.nodes)) if (isTurn(x)) for (const l of x.lessons ?? []) keys.add(l.key || conceptKey(l.title));
    return keys.size;
  }, [store.nodes]);
  const learnOn = board?.learn?.on !== false;

  const boardView = board ? (
    <div className="stage" key={board.id}>
      <div className="view">
        <div className={`pane ${view === 'chat' ? 'on' : ''}`} aria-hidden={view !== 'chat'} inert={view !== 'chat'}>
          {wasOpened('chat') && <Chat board={board} targetId={targetId} setTargetId={setTargetId} openDetails={setOpenId} onImport={() => setSheet('import')} />}
        </div>
        <div className={`pane ${view === 'canvas' ? 'on' : ''}`} aria-hidden={view !== 'canvas'} inert={view !== 'canvas'}>
          {wasOpened('canvas') && <Canvas board={board} targetId={targetId} setTargetId={setTargetId} openDetails={setOpenId} focus={focus} active={view === 'canvas' && page === 'board'} />}
        </div>
        <div className={`pane ${view === 'code' ? 'on' : ''}`} aria-hidden={view !== 'code'} inert={view !== 'code'}>
          {wasOpened('code') && <CodeView board={board} target={target} setTargetId={setTargetId} openRequest={codeOpen} />}
        </div>
      </div>
      <Composer key={board.id} target={target} board={board} onSubmit={submit} onClear={() => setTargetId(null)} />
    </div>
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
              {!mobile && <span className="seg-label">Chat</span>}
            </>
          ),
        },
        {
          value: 'canvas',
          label: (
            <>
              <Icon name="canvas" size={14} />
              {!mobile && <span className="seg-label">Canvas</span>}
            </>
          ),
        },
        {
          value: 'code',
          label: (
            <>
              <Icon name="code" size={14} />
              {!mobile && <span className="seg-label">Code</span>}
            </>
          ),
        },
      ]}
    />
  );

  const paletteItems: PaletteItem[] = [];
  if (palette) {
    const views: [View, string, 'chat' | 'canvas' | 'code'][] = [
      ['chat', 'Chat view', 'chat'],
      ['canvas', 'Canvas view', 'canvas'],
      ['code', 'Code view', 'code'],
    ];
    for (const [v, label, icon] of views) if (board) paletteItems.push({ id: `v-${v}`, group: 'Views', label, icon, run: () => setView(v) });
    paletteItems.push(
      { id: 'a-new', group: 'Actions', label: 'New thread', icon: 'plus', run: () => (setTargetId(null), setTab('board'), setTimeout(() => composerFocus.current?.focus(), 50)) },
      { id: 'a-board', group: 'Actions', label: 'New board', icon: 'folder', run: () => setSheet('new') },
      { id: 'a-devices', group: 'Actions', label: 'Set up your phone', icon: 'phone', run: () => (settingsTab('phone'), mobile ? setTab('devices') : setSheet('devices')) },
    );
    paletteItems.push(
      { id: 'a-bug', group: 'Actions', label: 'Report a bug', icon: 'external', run: () => open(bugReportUrl(), '_blank') },
      { id: 'a-idea', group: 'Actions', label: 'Suggest an idea', icon: 'spark', run: () => open(ideaUrl(), '_blank') },
    );
    if (board) paletteItems.push({ id: 'a-settings', group: 'Actions', label: 'Board settings', icon: 'settings', run: () => setSheet('board') });
    if (board) paletteItems.push({ id: 'a-import', group: 'Actions', label: 'Bring in Claude Code sessions', icon: 'download', run: () => setSheet('import') });
    paletteItems.push({ id: 'a-away', group: 'Actions', label: 'Away mode', hint: 'Keep this computer awake', icon: 'moon', run: goAway });
    paletteItems.push({ id: 'a-update', group: 'Actions', label: 'Check for updates', icon: 'refresh', run: () => (settingsTab('updates'), mobile ? setTab('devices') : setSheet('devices')) });
    paletteItems.push({ id: 'a-learn', group: 'Actions', label: 'Concepts I’ve learned', icon: 'spark', run: () => (mobile ? setTab('learn') : setPage('concepts')) });
    for (const b of store.boards) paletteItems.push({ id: `b-${b.id}`, group: 'Boards', label: b.name, hint: b.cwd.replace(store.home, '~'), icon: 'grid', run: () => (setBoardId(b.id), setTab('board')) });
    if (board)
      for (const t of leaves(store.nodes, board.id))
        paletteItems.push({ id: `t-${t.id}`, group: 'Branches', label: t.prompt, hint: STATUS_LABEL[t.status], color: branchColor(t.branchId), run: () => goTo(t) });
    const branchFiles = target ? fileCache.get(target.branchId) : undefined;
    if (board && branchFiles)
      for (const f of branchFiles)
        paletteItems.push({
          id: `f-${f}`,
          group: 'Files',
          label: f.split('/').pop()!,
          hint: f,
          icon: 'file',
          keywords: f,
          run: () => {
            setView('code');
            setTab('board');
            setCodeOpen({ path: f, n: Date.now() });
          },
        });
  }

  const sheets = (
    <>
      {palette && <Palette items={paletteItems} onClose={() => setPalette(false)} />}
      {sheet === 'new' && (
        <NewBoard
          onClose={() => setSheet(null)}
          onCreated={(b) => {
            setBoardId(b.id);
            setSheet(null);
            setTab('board');
            // The folder already has Claude Code history? Offer to bring it in.
            request<{ imported: boolean }[]>({ type: 'listSessions', boardId: b.id })
              .then((l) => l.some((s) => !s.imported) && setSheet('import'))
              .catch(() => {});
          }}
        />
      )}
      {sheet === 'board' && board && <BoardSettings board={board} onClose={() => setSheet(null)} />}
      {sheet === 'import' && board && (
        <ImportSessions
          board={board}
          onClose={() => setSheet(null)}
          onDone={(head) => {
            setSheet(null);
            if (head) {
              setTargetId(head);
              setFocus({ id: head, n: Date.now() });
            }
          }}
        />
      )}
      {sheet === 'devices' && (
        <Sheet title="Settings" onClose={() => setSheet(null)} wide>
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
            onSettings={(id) => {
              setBoardId(id);
              setSheet('board');
            }}
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
            <button className="icon-btn" onClick={() => setPalette(true)} aria-label="Search">
              <Icon name="spark" size={19} />
            </button>
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
          {tab === 'learn' && (
            <div className="page">
              <div className="page-inner">
                <h1 className="page-title">Concepts</h1>
                <LearnLibrary
                  onOpen={(t) => {
                    goTo(t);
                    setView('chat');
                  }}
                />
              </div>
            </div>
          )}
          {tab === 'devices' && (
            <div className="page">
              <div className="page-inner">
                <h1 className="page-title">Settings</h1>
                <Settings />
                <a className="credit center" href="https://github.com/nikhils4" target="_blank" rel="noreferrer">
                  Forkspace · Built by <b>nikhils4</b>
                </a>
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
          <button className={tab === 'learn' ? 'on' : ''} onClick={() => setTab('learn')}>
            <Icon name="spark" size={22} />
            <span>Learn</span>
          </button>
          <button className={tab === 'devices' ? 'on' : ''} onClick={() => setTab('devices')}>
            <Icon name="settings" size={22} />
            <span>Settings</span>
          </button>
        </nav>
        {openNode && <Drawer node={openNode} onClose={() => setOpenId(null)} />}
        {sheets}
      <AwayScreen onGoTo={goTo} />
      </div>
    );
  }

  // ---------------- desktop ----------------
  return (
    <div className={`app ${openNode ? 'drawer-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="app-mark">
            <Icon name="branch" size={15} strokeWidth={2.25} />
          </div>
          <span>Forkspace</span>
          <ConnDot />
          <ThemeToggle />
        </div>

        <div className="side-scroll">
          <button className={`side-link side-top ${page === 'concepts' ? 'on' : ''}`} onClick={() => setPage(page === 'concepts' ? 'board' : 'concepts')}>
            <span className="mentor-orb small" /> Concepts
            <span className="spacer" />
            {lessonCount > 0 && <span className="count">{lessonCount}</span>}
          </button>
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
              setPage('board');
            }}
            onSettings={(id) => {
              setBoardId(id);
              setSheet('board');
            }}
          />

          <div className="side-head">
            <span>Agents</span>
            {waiting.length > 0 && <span className="pill warn">{waiting.length} need you</span>}
          </div>
          <SidebarAgents onOpen={(t) => (setPage('board'), goTo(t))} />
        </div>

        <div className="side-foot">
          <UpdatePill onOpen={() => (settingsTab('updates'), setSheet('devices'))} />
          <InstallButton />
          <AwayLink />
          <button className="side-link" onClick={() => setSheet('devices')}>
            <Icon name="settings" size={15} /> Settings
          </button>
          <a className="credit" href="https://github.com/nikhils4" target="_blank" rel="noreferrer">
            Built by <b>nikhils4</b>
          </a>
        </div>
      </aside>

      <main className="main">
        <ConnectionBanner />
        {page === 'concepts' && (
          <div className="concepts-page">
            <header className="topbar">
              <div className="concepts-title">
                <span className="mentor-orb" /> Concepts
              </div>
              <span className="spacer" />
              {board && (
                <button className="btn sm ghost" onClick={() => setPage('board')}>
                  <Icon name="chevronLeft" size={14} /> Back to {board.name}
                </button>
              )}
            </header>
            <div className="page">
              <div className="page-inner concepts-inner">
                <LearnLibrary
                  onOpen={(t) => {
                    setPage('board');
                    goTo(t);
                    setView('chat');
                  }}
                />
              </div>
            </div>
          </div>
        )}
        {board && page === 'board' && (
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
            <button
              className={`pill learn-pill ${learnOn ? 'on' : ''}`}
              onClick={() => send({ type: 'updateBoard', id: board.id, patch: { learn: { on: !learnOn, level: board.learn?.level ?? 'growing' } } })}
              title={learnOn ? 'Learning concepts as agents work' : 'Learn concepts as agents work'}
            >
              <span className="mentor-orb small" />
              Learn {learnOn ? 'on' : 'off'}
            </button>
            <span className="spacer" />
            <button className="kbar-btn" onClick={() => setPalette(true)} title="Search (⌘K)">
              <Icon name="spark" size={14} />
              <span className="seg-label">Search</span>
              <kbd>⌘K</kbd>
            </button>
            {viewSwitch}
          </header>
        )}
        {/* Kept mounted behind the Concepts page so the canvas keeps its place. */}
        <div className="main-body" style={page === 'concepts' ? { display: 'none' } : undefined}>
          {boardView}
        </div>
      </main>

      {openNode && <Drawer node={openNode} onClose={() => setOpenId(null)} />}
      {sheets}
      <AwayScreen onGoTo={goTo} />
    </div>
  );
}

function BoardList({
  boards,
  current,
  onPick,
  onNew,
  onSettings,
}: {
  boards: Board[];
  current?: string;
  onPick: (id: string) => void;
  onNew?: () => void;
  onSettings?: (id: string) => void;
}) {
  const { nodes } = useStore();
  const [menu, setMenu] = useState<{ x: number; y: number; board: Board } | null>(null);
  const items = (b: Board): MenuItem[] => {
    const steps = Object.values(nodes).filter((n) => n.boardId === b.id).length;
    return [
      { label: 'Open', icon: 'canvas', onClick: () => onPick(b.id) },
      ...(onSettings ? [{ label: 'Board settings', icon: 'settings' as const, onClick: () => onSettings(b.id) }] : []),
      'sep',
      {
        label: 'Start fresh',
        icon: 'refresh',
        disabled: steps === 0,
        confirm: `Click again to clear ${steps} card${steps === 1 ? '' : 's'}`,
        onClick: () => {
          send({ type: 'clearBoard', id: b.id });
          onPick(b.id);
          toast(`${b.name} is fresh`);
        },
      },
      {
        label: 'Delete board',
        icon: 'trash',
        danger: true,
        confirm: 'Click again to delete',
        onClick: () => {
          send({ type: 'deleteBoard', id: b.id });
          toast(`Deleted ${b.name}`);
        },
      },
    ];
  };
  return (
    <div className="board-list">
      {menu && <ContextMenu key={`${menu.x},${menu.y}`} x={menu.x} y={menu.y} items={items(menu.board)} onClose={() => setMenu(null)} />}
      {boards.map((b) => {
        const live = Object.values(nodes).filter((n): n is TurnNode => isTurn(n) && n.boardId === b.id && isLive(n));
        const needs = live.filter((n) => n.status === 'waiting').length;
        return (
          <div key={b.id} className="board-row">
            <button
              className={`board-item ${b.id === current ? 'on' : ''}`}
              onClick={() => onPick(b.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, board: b });
              }}
            >
              <span className="board-initial">{b.name.slice(0, 1).toUpperCase()}</span>
              <span className="ellipsis">{b.name}</span>
              <span className="spacer" />
              {needs > 0 ? <span className="count warn">{needs}</span> : live.length > 0 ? <span className="count">{live.length}</span> : null}
            </button>
            <button
              className={`board-more ${menu?.board.id === b.id ? 'open' : ''}`}
              aria-label={`More for ${b.name}`}
              title="More"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom + 4, board: b });
              }}
            >
              <Icon name="more" size={16} />
            </button>
          </div>
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

function ThemeToggle() {
  const t = useResolvedTheme();
  return (
    <button className="icon-btn sm theme-toggle" onClick={() => setTheme(t === 'dark' ? 'light' : 'dark')} aria-label={t === 'dark' ? 'Switch to light' : 'Switch to dark'} title={t === 'dark' ? 'Light mode' : 'Dark mode'}>
      <Icon name={t === 'dark' ? 'sun' : 'moon'} size={15} />
    </button>
  );
}

function ConnDot() {
  const { connected } = useStore();
  return <span className={`conn ${connected ? 'on' : ''}`} title={connected ? 'Connected to your Mac' : 'Reconnecting…'} />;
}

function ConnectionBanner() {
  const { connected, loaded, update } = useStore();
  const [show, setShow] = useState(false);
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (connected) {
      setShow(false);
      setLong(false);
      return;
    }
    const t = setTimeout(() => setShow(true), 1200);
    // Still down after a while (and not mid-update): it probably stopped. Say how to start it.
    const t2 = setTimeout(() => setLong(true), 7000);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [connected]);
  if (!show || !loaded) return null;
  const updating = update && !update.done && !update.error;
  if (long && !updating)
    return (
      <div className="conn-card">
        <div className="conn-card-head">
          <span className="spinner" /> Forkspace stopped running. Waiting for it…
        </div>
        <StartCommand compact />
      </div>
    );
  return (
    <div className="conn-banner">
      <span className="spinner" /> {updating ? 'Updating Forkspace. Back in a moment…' : 'Reconnecting to your Mac…'}
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
