import { ReactFlowProvider } from '@xyflow/react';
import { NoteSheet, setCodeOpener } from './ThreadNotes.tsx';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Board, TurnNode } from '../shared/types.ts';
import { BoardSettings, NewBoard } from './BoardForms.tsx';
import { Canvas } from './Canvas.tsx';
import { Chat } from './Chat.tsx';
import { ShotViewer } from './Shots.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
// The terminal (xterm) loads only when you open it.
const MapView = lazy(() => import('./MapView.tsx').then((m) => ({ default: m.MapView })));
const TerminalPanel = lazy(() => import('./Terminal.tsx').then((m) => ({ default: m.TerminalPanel })));
import { bugReportUrl, ideaUrl } from './feedback.ts';
import { CodeView, fileCache } from './CodeView.tsx';
import { Composer, composerFocus, wantFork } from './Composer.tsx';
import { Drawer } from './Drawer.tsx';
import { PairScreen, Splash, StartCommand, UnreachableScreen } from './Gate.tsx';
import { Icon } from './icons.tsx';
import { Inbox, useAgents } from './Inbox.tsx';
import { WorkPage } from './Threads.tsx';
import { Dock, TabStrip, type ActiveTab } from './Workspace.tsx';
import { ChangesPane, NewThreadPane, ThreadList, ThreadReader } from './Reader.tsx';
import { threadsOf } from './status.ts';
import { ImportSessions } from './Import.tsx';
import { LearnLibrary } from './Learn.tsx';
import { NotesPage } from './Notes.tsx';
import { UpdatePill } from './Updates.tsx';
import { setTheme, toggleTerminal, useResolvedTheme, useTheme } from './theme.ts';
import { placeFor, placement } from './layout.ts';
import { useInstall } from './pwa.ts';
import { Palette, type PaletteItem } from './Palette.tsx';
import { Settings, settingsTab } from './Settings.tsx';
import { request, send, toast, useStore } from './store.ts';
import { branchColor, STATUS_LABEL } from './nodes.tsx';
import { isLive, isTurn, latestLeaf, leaves } from './tree.ts';
import { clearReady, useReady, useWatchFinishes } from './review.ts';
import { Segmented, Sheet, useIsMobile } from './ui.tsx';

type View = 'chat' | 'canvas' | 'code' | 'map';
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
  const [openId, setOpenIdRaw] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [sheet, setSheet] = useState<null | 'new' | 'board' | 'devices' | 'boards' | 'learn' | 'import'>(null);
  // Desktop: the main area shows a board, or the Concepts page.
  const [page, setPage] = useState<'board' | 'concepts' | 'notes' | 'work'>('board');
  const [learnPage, setLearnPage] = useState<'concepts' | 'notes'>('concepts');
  const filedCount = Object.values(store.nodes).filter((n) => n.kind === 'note' && n.filed).length;
  const [termOpen, setTermOpen] = useState(false);
  // A card's "Terminal here": show the panel and open a terminal in that card's folder.
  const [termFor, setTermFor] = useState<{ branchId: string; n: number; type?: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ branchId: string; type?: string }>).detail;
      setTermFor({ branchId: d.branchId, type: d.type, n: Date.now() });
      setTermOpen(true);
    };
    addEventListener('forkspace:term-for', on);
    return () => removeEventListener('forkspace:term-for', on);
  }, []);
  const [tab, setTab] = useState<Tab>('board');
  const [palette, setPalette] = useState(false);
  const [codeOpen, setCodeOpen] = useState<{ path: string; line?: number; n: number } | null>(null);
  // Views are mounted on first visit and then kept alive, so switching never loses your place.
  const [visited, setVisited] = useState<Record<string, View[]>>({});
  const { waiting, running } = useAgents();
  // Branches that need you: a question, a failure, failing checks or open PR comments.
  const readySet = useReady();
  const workCount = useMemo(
    () => threadsOf(store.nodes, store.branches, store.boards, readySet).reduce((a, t) => a + t.branches.filter((b) => ['needs', 'error', 'failing', 'feedback'].includes(b.stage)).length, 0),
    [store.nodes, store.branches, store.boards, readySet],
  );
  useWatchFinishes(store.nodes, store.loaded);

  const board = store.boards.find((b) => b.id === boardId) ?? store.boards[0] ?? null;
  // Desktop: which view each board shows (Threads, Canvas, Code, Map) and the step last open there.
  const [activeBy, setActiveBy] = useState<Record<string, ActiveTab>>(() => {
    try {
      return JSON.parse(ls.get('forkspace:active') || '{}');
    } catch {
      return {};
    }
  });
  const [lastOpen, setLastOpen] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(ls.get('forkspace:last-open') || '{}');
    } catch {
      return {};
    }
  });
  useEffect(() => ls.set('forkspace:active', JSON.stringify(activeBy)), [activeBy]);
  useEffect(() => ls.set('forkspace:last-open', JSON.stringify(lastOpen)), [lastOpen]);
  const rawDesk = (board && activeBy[board.id]) || 'stacks';
  const desk: ActiveTab = (['stacks', 'canvas', 'code', 'map'] as string[]).includes(rawDesk) ? rawDesk : 'stacks';
  // The right pane (what the step changed) can be hidden for more reading room.
  const [sideOpen, setSideOpen] = useState(() => ls.get('forkspace:changes') !== 'closed');
  useEffect(() => ls.set('forkspace:changes', sideOpen ? 'open' : 'closed'), [sideOpen]);
  const view: View = mobile ? (board && views[board.id]) || 'chat' : desk === 'code' || desk === 'map' ? desk : 'canvas';
  const targetId = board ? (targets[board.id] ?? null) : null;
  const target = targetId && isTurn(store.nodes[targetId]) ? (store.nodes[targetId] as TurnNode) : undefined;

  // The details panel, the selected card and the terminal follow each other:
  // opening details on a card selects it (the terminal follows the selection), and
  // selecting another card (clicking it, or sending a prompt) moves an open panel to it.
  const setOpenId = useCallback(
    (id: string | null) => {
      setOpenIdRaw(id);
      clearReady(id);
      const n = id ? store.nodes[id] : undefined;
      if (n && isTurn(n) && !isLive(n) && n.boardId === board?.id && n.sessionId && n.id !== targetId) setTargets((x) => ({ ...x, [n.boardId]: n.id }));
    },
    [store.nodes, board?.id, targetId],
  );
  // Also when the step only just arrived: a new thread's card can land a moment after you send.
  const targetLoaded = !!(targetId && store.nodes[targetId]);
  useEffect(() => {
    if (targetId && openId && openId !== targetId && isTurn(store.nodes[targetId])) setOpenIdRaw(targetId);
  }, [targetId, targetLoaded]);
  // Desktop: a step that opens (a card clicked, a notification, a search hit) reads in the
  // Threads view, with its thread picked on the left.
  const openLoaded = !!(openId && store.nodes[openId]);
  useEffect(() => {
    if (mobile || !openId || !isTurn(store.nodes[openId])) return;
    const n = store.nodes[openId] as TurnNode;
    if (n.boardId !== board?.id) setBoardId(n.boardId);
    setActiveBy((x) => ({ ...x, [n.boardId]: 'stacks' }));
    setLastOpen((x) => ({ ...x, [n.boardId]: n.id }));
  }, [openId, openLoaded, mobile]);
  // Coming back to Threads (or to a board): open the step you were last reading.
  useEffect(() => {
    if (mobile || !board || desk !== 'stacks' || page !== 'board' || openId) return;
    const id = lastOpen[board.id];
    if (id && isTurn(store.nodes[id]) && store.nodes[id].boardId === board.id) setOpenIdRaw(id);
  }, [board?.id, desk, page, mobile]);
  // The details panel belongs to the board: going to Concepts or Notes closes it.
  useEffect(() => {
    if (page !== 'board') setOpenIdRaw(null);
  }, [page]);

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
      if (!mobile) (setPage('board'), setOpenIdRaw(dest), clearReady(dest));
    },
    [store.nodes, mobile],
  );

  /** Go to exactly this card (a branch's latest step), without following newer forks. */
  const goExact = useCallback((t: TurnNode) => {
    setBoardId(t.boardId);
    setPage('board');
    setTargets((x) => ({ ...x, [t.boardId]: isLive(t) || t.sessionId ? t.id : x[t.boardId] ?? null }));
    setTab('board');
    setFocus({ id: t.id, n: Date.now() });
    if (!mobile) (setOpenIdRaw(t.id), clearReady(t.id));
  }, [mobile]);

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
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyT') {
        e.preventDefault();
        toggleTerminal();
        return;
      }
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        setPage('board');
        setTermOpen((v) => !v);
        return;
      }
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable], .cm-editor')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' || e.key === 'r') {
        e.preventDefault();
        if (e.key === 'r') wantFork(null);
        composerFocus.current?.focus();
      }
      // B: branch from the open card (or the one you're replying to).
      if (e.key === 'b') {
        const id = openId ?? targetId;
        if (id) {
          e.preventDefault();
          wantFork(id);
          if (!openId) setTargetId(id);
          setTimeout(() => composerFocus.current?.focus(), 0);
        }
      }
      if (e.key === 'Escape' && !openId && !sheet && page !== 'board') return setPage('board');
      if (!mobile && board && desk === 'stacks' && (e.key === ']' || e.key === '[')) return setSideOpen((v) => !v);
      if (!mobile && board && ['1', '2', '3', '4'].includes(e.key)) {
        setPage('board');
        return pickTab((['stacks', 'canvas', 'code', 'map'] as const)[Number(e.key) - 1]);
      }
      if (e.key === 'Escape' && !openId && !sheet) setTargetId(null);
      if (board && ['1', '2', '3'].includes(e.key)) {
        setPage('board');
        setViews((v) => ({ ...v, [board.id]: (['chat', 'canvas', 'code'] as const)[Number(e.key) - 1] }));
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [openId, targetId, sheet, board?.id, setTargetId, page, desk, mobile]);

  const submit = async (prompt: string, attachments: Attachment[] = [], parentId: string | null = targetId, fork = false) => {
    if (!board) return false;
    const { position, moves } = placement(store.nodes, board.id, parentId, { x: 0, y: 0 });
    try {
      if (moves.length) send({ type: 'move', moves });
      const { id, queued } = await request<{ id: string; queued?: boolean }>({ type: 'send', boardId: board.id, parentId, prompt, position, attachments, fork });
      // Sent to a step that's still working: it waits on that card and runs next.
      if (queued) return toast('Queued. It runs as the next step when this one finishes.'), true;
      setTargetId(id);
      setFocus({ id, n: Date.now() });
      if (!mobile && !parentId) setOpenIdRaw(id);
      return true;
    } catch (err: any) {
      toast(err.message, 'error');
      return false;
    }
  };

  // ---- desktop views ----
  function pickTab(t: ActiveTab) {
    if (!board) return;
    setPage('board');
    setActiveBy((x) => ({ ...x, [board.id]: t }));
    // Threads keeps the step you're reading; the other views have their own selection.
    if (t !== 'stacks') setOpenIdRaw(null);
    else if (!openId && lastOpen[board.id] && isTurn(store.nodes[lastOpen[board.id]])) setOpenIdRaw(lastOpen[board.id]);
  }
  const newThread = () => {
    setPage('board');
    if (board) setActiveBy((x) => ({ ...x, [board.id]: 'stacks' }));
    setOpenIdRaw(null);
    if (board) setLastOpen((x) => ({ ...x, [board.id]: '' }));
    setTargetId(null);
    setTimeout(() => composerFocus.current?.focus(), 60);
  };

  const setView = (v: View) => board && setViews((x) => ({ ...x, [board.id]: v }));
  // A `path:line` in a thread note opens that file in the Code view, on the note's board.
  useEffect(() => {
    setCodeOpener((bid, path, line) => {
      setBoardId(bid);
      setPage('board');
      setTab('board');
      setOpenIdRaw(null);
      setViews((x) => ({ ...x, [bid]: 'code' }));
      setActiveBy((x) => ({ ...x, [bid]: 'code' }));
      setCodeOpen({ path, line, n: Date.now() });
    });
  }, []);
  useEffect(() => {
    if (board && !(visited[board.id] ?? []).includes(view)) setVisited((x) => ({ ...x, [board.id]: [...(x[board.id] ?? []), view] }));
  }, [board?.id, view]);
  const wasOpened = (v: View) => v === view || (board ? (visited[board.id] ?? []).includes(v) : false);
  const openNode = openId && isTurn(store.nodes[openId]) ? (store.nodes[openId] as TurnNode) : null;

  // Concepts: thread notes kept.
  const lessonCount = store.concepts.length;

  // The details panel has its own message box, always for the step it shows.
  const drawerComposer =
    board && openNode && openNode.sessionId ? (
      <Composer key={openNode.id} docked target={openNode} board={board} onSubmit={(p, a, f) => submit(p, a, openNode.id, f)} />
    ) : null;

  const boardView = board ? (
    <div className="stage" key={board.id}>
      <div className="view">
        <div className={`pane ${view === 'chat' ? 'on' : ''}`} aria-hidden={view !== 'chat'} inert={view !== 'chat'}>
          {mobile && wasOpened('chat') && <Chat board={board} targetId={targetId} setTargetId={setTargetId} openDetails={setOpenId} onImport={() => setSheet('import')} />}
        </div>
        <div className={`pane ${view === 'canvas' ? 'on' : ''}`} aria-hidden={view !== 'canvas'} inert={view !== 'canvas'}>
          {wasOpened('canvas') && <Canvas board={board} targetId={targetId} setTargetId={setTargetId} openDetails={setOpenId} focus={focus} active={view === 'canvas' && page === 'board' && (mobile || desk === 'canvas')} />}
        </div>
        <div className={`pane ${view === 'code' ? 'on' : ''}`} aria-hidden={view !== 'code'} inert={view !== 'code'}>
          {wasOpened('code') && <CodeView board={board} target={target} setTargetId={setTargetId} openRequest={codeOpen} />}
        </div>
        <div className={`pane ${view === 'map' ? 'on' : ''}`} aria-hidden={view !== 'map'} inert={view !== 'map'}>
          {wasOpened('map') && (
            <Suspense fallback={null}>
              <MapView
                board={board}
                onOpenFile={(f, line) => {
                  setCodeOpen({ path: f, line, n: Date.now() });
                  if (mobile) setView('code');
                  else pickTab('code');
                }}
                onStartThread={async (prompt) => {
                  const position = placeFor(store.nodes, board.id, null, { x: 0, y: 0 });
                  try {
                    const { id } = await request<{ id: string }>({ type: 'send', boardId: board.id, parentId: null, prompt, position });
                    return id;
                  } catch (err: any) {
                    toast(err.message, 'error');
                    return null;
                  }
                }}
                onOpenThread={(id) => {
                  setTargetId(id);
                  setFocus({ id, n: Date.now() });
                  if (mobile) setView('canvas');
                  else setOpenIdRaw(id);
                }}
              />
            </Suspense>
          )}
        </div>
      </div>
      {/* The map has its own box, for questions about the code. */}
      {(mobile ? view !== 'map' && !drawerComposer : desk === 'canvas' || desk === 'code') && (
        <Composer key={board.id} target={target} board={board} onSubmit={(p, a, f) => submit(p, a, targetId, f)} onClear={() => setTargetId(null)} drawerOpen={mobile && !!openNode} />
      )}
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
        {
          value: 'map',
          label: (
            <>
              <Icon name="grid" size={14} />
              {!mobile && <span className="seg-label">Map</span>}
            </>
          ),
        },
      ]}
    />
  );

  const paletteItems: PaletteItem[] = [];
  if (palette) {
    const views: [View, string, 'chat' | 'canvas' | 'code' | 'grid'][] = [
      ['chat', 'Chat view', 'chat'],
      ['canvas', 'Canvas view', 'canvas'],
      ['code', 'Code view', 'code'],
      ['map', 'Map of the codebase', 'grid'],
    ];
    for (const [v, label, icon] of views) if (board && (mobile || v !== 'chat')) paletteItems.push({ id: `v-${v}`, group: 'Views', label, icon, run: () => (mobile ? setView(v) : pickTab(v as ActiveTab)) });
    if (board && !mobile) paletteItems.push({ id: 'v-stacks', group: 'Views', label: 'Threads', icon: 'overview', run: () => pickTab('stacks') });
    paletteItems.push(
      { id: 'a-new', group: 'Actions', label: 'New thread', icon: 'plus', run: () => (mobile ? (setOpenId(null), setTargetId(null), setTab('board'), setTimeout(() => composerFocus.current?.focus(), 50)) : newThread()) },
      { id: 'a-board', group: 'Actions', label: 'New board', icon: 'folder', run: () => setSheet('new') },
      { id: 'a-devices', group: 'Actions', label: 'Set up your phone', icon: 'phone', run: () => (settingsTab('phone'), mobile ? setTab('devices') : setSheet('devices')) },
    );
    paletteItems.push(
      { id: 'a-bug', group: 'Actions', label: 'Report a bug', icon: 'external', run: () => open(bugReportUrl(), '_blank') },
      { id: 'a-idea', group: 'Actions', label: 'Suggest an idea', icon: 'spark', run: () => open(ideaUrl(), '_blank') },
    );
    if (board) paletteItems.push({ id: 'a-settings', group: 'Actions', label: 'Board settings', icon: 'settings', run: () => setSheet('board') });
    if (board) paletteItems.push({ id: 'a-import', group: 'Actions', label: 'Bring in Claude Code sessions', icon: 'download', run: () => setSheet('import') });
    if (board) paletteItems.push({ id: 'a-term', group: 'Actions', label: termOpen ? 'Hide terminal' : 'Open terminal', hint: 'Ctrl+`', icon: 'terminal', run: () => (setPage('board'), setTab('board'), setTermOpen(!termOpen)) });
    paletteItems.push({ id: 'a-update', group: 'Actions', label: 'Check for updates', icon: 'refresh', run: () => (settingsTab('updates'), mobile ? setTab('devices') : setSheet('devices')) });
    paletteItems.push({ id: 'a-notes', group: 'Actions', label: 'Notes', hint: 'Notes kept for later', icon: 'folder', run: () => (mobile ? (setTab('learn'), setLearnPage('notes')) : setPage('notes')) });
    paletteItems.push({ id: 'a-learn', group: 'Actions', label: 'Concepts: notes of past threads', icon: 'spark', run: () => (mobile ? setTab('learn') : setPage('concepts')) });
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
            if (mobile) setView('code');
            else pickTab('code');
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
          {tab === 'board' && termOpen && board && (
            <Suspense fallback={null}>
              <TerminalPanel board={board} branchId={target?.branchId} openFor={termFor} onClose={() => setTermOpen(false)} />
            </Suspense>
          )}
          {tab === 'agents' && <Inbox onOpen={goTo} />}
          {tab === 'learn' && (
            <div className="page">
              <div className="page-inner">
                <div className="page-title-row">
                  <h1 className="page-title">{learnPage === 'notes' ? 'Notes' : 'Concepts'}</h1>
                  <Segmented<'concepts' | 'notes'>
                    value={learnPage}
                    onChange={setLearnPage}
                    options={[
                      { value: 'concepts', label: 'Concepts' },
                      { value: 'notes', label: 'Notes' },
                    ]}
                  />
                </div>
                {learnPage === 'notes' ? (
                  <NotesPage board={board ?? undefined} />
                ) : (
                  <LearnLibrary
                    onOpen={(t) => {
                      goTo(t);
                      setView('chat');
                    }}
                  />
                )}
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
        {openNode && <Drawer node={openNode} onClose={() => setOpenId(null)} onReply={(id) => (setTargetId(id), setTimeout(() => composerFocus.current?.focus(), 0))} onGo={(id) => (setOpenId(id), setFocus({ id, n: Date.now() }))} onBranch={(p) => void submit(p, [], openNode.id, true)} composer={drawerComposer} />}
        {sheets}
      <ShotViewer />
      <NoteSheet />
      </div>
    );
  }

  // ---------------- desktop ----------------
  // Like a browser: tabs on top, the page in the middle, the terminal under it, a status bar below.
  const reading = desk === 'stacks' && openNode && openNode.boardId === board?.id ? openNode : null;
  const pageTitle = { concepts: 'Concepts', work: 'Work', notes: 'Notes' } as const;
  const togglePage = (p: 'work' | 'notes' | 'concepts') => setPage(page === p ? 'board' : p);
  return (
    <div className="app ws">
      {board ? (
        <TabStrip board={board} active={page === 'board' ? desk : ('' as ActiveTab)} onPick={pickTab} onSearch={() => setPalette(true)} />
      ) : (
        <header className="ws-tabs" />
      )}
      <main className="main ws-main">
        <ConnectionBanner />
        {page !== 'board' && (
          <div className="concepts-page page-enter">
            <header className="ws-page-head">
              <h1>{pageTitle[page]}</h1>
              <span className="spacer" />
              {board && (
                <button className="btn sm ghost" onClick={() => setPage('board')}>
                  <Icon name="chevronLeft" size={14} /> Back to {board.name}
                </button>
              )}
            </header>
            <div className="page">
              <div className={`page-inner ${page === 'work' ? '' : 'concepts-inner'}`}>
                {page === 'concepts' && (
                  <LearnLibrary
                    onOpen={(t) => {
                      setPage('board');
                      goTo(t);
                    }}
                  />
                )}
                {page === 'work' && <WorkPage onGo={goExact} />}
                {page === 'notes' && <NotesPage board={board ?? undefined} />}
              </div>
            </div>
          </div>
        )}
        {/* Kept mounted behind the other tabs so the canvas and code keep their place. */}
        <div className="main-body" style={page !== 'board' || desk === 'stacks' ? { display: 'none' } : undefined}>
          {boardView}
        </div>
        {board && page === 'board' && desk === 'stacks' && (
          <div className={`tp ${reading && sideOpen ? '' : 'no-side'}`}>
            <ThreadList boardId={board.id} current={reading} onPick={(t) => setOpenId(t.id)} onNew={newThread} />
            {reading ? (
              <ThreadReader
                stepId={reading.id}
                onSelect={(id) => setOpenId(id)}
                onBranch={(p) => void submit(p, [], reading.id, true)}
                composer={drawerComposer}
                sideOpen={sideOpen}
                onToggleSide={() => setSideOpen(!sideOpen)}
              />
            ) : (
              <NewThreadPane count={leaves(store.nodes, board.id).length} composer={<Composer key={`new-${board.id}`} board={board} onSubmit={(p, a) => submit(p, a, null)} />} />
            )}
            {reading && sideOpen && <ChangesPane node={reading} />}
          </div>
        )}
        {termOpen && board && (
          <Suspense fallback={null}>
            <TerminalPanel board={board} branchId={reading?.branchId ?? target?.branchId} openFor={termFor} onClose={() => setTermOpen(false)} docked />
          </Suspense>
        )}
      </main>
      <Dock
        board={board}
        boards={store.boards}
        page={page}
        counts={{ work: workCount, notes: filedCount, concepts: lessonCount }}
        agents={[...waiting, ...running]}
        termOpen={termOpen}
        onBoard={(id) => {
          setBoardId(id);
          setOpenIdRaw(null);
          setPage('board');
        }}
        onNewBoard={() => setSheet('new')}
        onBoardSettings={() => setSheet('board')}
        onPage={togglePage}
        onAgent={(t) => goTo(t)}
        onTerminal={() => setTermOpen(!termOpen)}
        onSettings={() => setSheet('devices')}
        extra={
          <>
            <UpdatePill onOpen={() => (settingsTab('updates'), setSheet('devices'))} />
            <InstallButton />
            <ThemeToggle />
          </>
        }
      />
      {!board && <Welcome onNew={() => setSheet('new')} />}
      {sheets}
      <ShotViewer />
      <NoteSheet />
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

/** Light, dark or terminal, one tap each. "System" lives in Settings. */
function ThemeToggle() {
  const resolved = useResolvedTheme();
  const t = useTheme();
  const on = t === 'terminal' ? 'terminal' : resolved;
  const opts = [
    { v: 'light', icon: 'sun', label: 'Light' },
    { v: 'dark', icon: 'moon', label: 'Dark' },
    { v: 'terminal', icon: 'code', label: 'Terminal mode (⌥⌘T)' },
  ] as const;
  return (
    <div className="theme-pick" role="radiogroup" aria-label="Theme">
      {opts.map((o) => (
        <button key={o.v} role="radio" aria-checked={on === o.v} className={on === o.v ? 'on' : ''} title={o.label} aria-label={o.label} onClick={() => (o.v === 'terminal' ? on !== 'terminal' && toggleTerminal() : setTheme(o.v))}>
          <Icon name={o.icon} size={14} />
        </button>
      ))}
    </div>
  );
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
