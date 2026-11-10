import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Board, Isolation, NoteNode, PermissionMode, TurnNode } from '../shared/types.ts';
import { Md, NOTE_COLORS, NoteCard, STATUS_LABEL, ToolLine, TurnCard, branchColor, money } from './nodes.tsx';
import { request, send, toast, useStore } from './store.ts';

const nodeTypes = { turn: TurnCard, note: NoteCard };

const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask me', hint: 'Approve each risky tool call on the card' },
  { value: 'acceptEdits', label: 'Accept edits', hint: 'File edits run on their own; commands still ask' },
  { value: 'auto', label: 'Auto', hint: 'A classifier approves safe calls, asks when unsure' },
  { value: 'plan', label: 'Plan only', hint: 'Read and plan, no changes' },
  { value: 'bypassPermissions', label: 'Full access', hint: 'Never asks. Only for throwaway folders.' },
];

const uid = () => Math.random().toString(36).slice(2, 12);
const CARD_W = 380;

const lastBoardKey = 'forkspace:lastBoard';
const readLast = () => {
  try {
    return localStorage.getItem(lastBoardKey);
  } catch {
    return null;
  }
};

export default function App() {
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  );
}

function Shell() {
  const store = useStore();
  const [boardId, setBoardId] = useState<string | null>(readLast());
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const rf = useReactFlow();

  const board = store.boards.find((b) => b.id === boardId) ?? store.boards[0] ?? null;

  useEffect(() => {
    if (!board) return;
    try {
      localStorage.setItem(lastBoardKey, board.id);
    } catch {}
  }, [board?.id]);

  const turns = useMemo(() => Object.values(store.nodes).filter((n): n is TurnNode => n.kind === 'turn'), [store.nodes]);
  const active = turns.filter((t) => t.status === 'running' || t.status === 'waiting');
  const waitingCount = active.filter((t) => t.status === 'waiting').length;

  useEffect(() => {
    document.title = waitingCount ? `(${waitingCount}) Forkspace` : active.length ? `● Forkspace` : 'Forkspace';
  }, [waitingCount, active.length]);

  // Drop the target / drawer when their card is deleted (but not before a brand-new card first arrives).
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const id of Object.keys(store.nodes)) seen.current.add(id);
    if (targetId && seen.current.has(targetId) && !store.nodes[targetId]) setTargetId(null);
    if (openId && seen.current.has(openId) && !store.nodes[openId]) setOpenId(null);
  }, [store.nodes, targetId, openId]);

  const focusNode = (t: TurnNode) => {
    setBoardId(t.boardId);
    setTargetId(t.id);
    setTimeout(() => rf.setCenter(t.position.x + CARD_W / 2, t.position.y + 200, { zoom: 1, duration: 400 }), 50);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">⑂</span> Forkspace
          <span className={`conn ${store.connected ? 'on' : ''}`} title={store.connected ? 'Connected' : 'Reconnecting…'} />
        </div>

        <div className="side-section">
          <div className="side-title">
            Boards
            <button className="btn ghost small" onClick={() => setShowNew(true)}>
              + New
            </button>
          </div>
          {store.boards.map((b) => {
            const n = active.filter((t) => t.boardId === b.id).length;
            return (
              <button
                key={b.id}
                className={`side-item ${b.id === board?.id ? 'on' : ''}`}
                onClick={() => {
                  setBoardId(b.id);
                  setTargetId(null);
                }}
              >
                <span className="side-name">{b.name}</span>
                {n > 0 && <span className="badge">{n}</span>}
              </button>
            );
          })}
          {store.boards.length === 0 && <div className="muted small-pad">No boards yet.</div>}
        </div>

        <div className="side-section grow">
          <div className="side-title">Running agents</div>
          {active.length === 0 && <div className="muted small-pad">Nothing running.</div>}
          {active
            .sort((a, b) => (a.status === 'waiting' ? -1 : 1) - (b.status === 'waiting' ? -1 : 1))
            .map((t) => (
              <button key={t.id} className={`side-agent ${t.status}`} onClick={() => focusNode(t)}>
                <span className={`dot ${t.status}`} />
                <span className="side-agent-text">
                  <span className="side-agent-prompt">{t.prompt}</span>
                  <span className="muted">
                    {store.boards.find((b) => b.id === t.boardId)?.name} · {STATUS_LABEL[t.status]}
                  </span>
                </span>
              </button>
            ))}
        </div>
      </aside>

      <main className="main">
        {board ? (
          <BoardView key={board.id} board={board} targetId={targetId} setTargetId={setTargetId} setOpenId={setOpenId} />
        ) : (
          <Empty onNew={() => setShowNew(true)} />
        )}
      </main>

      {openId && store.nodes[openId]?.kind === 'turn' && <Drawer node={store.nodes[openId] as TurnNode} onClose={() => setOpenId(null)} />}
      {showNew && (
        <NewBoard
          onClose={() => setShowNew(false)}
          onCreated={(b) => {
            setBoardId(b.id);
            setShowNew(false);
          }}
        />
      )}

      <div className="toasts">
        {store.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function Empty({ onNew }: { onNew: () => void }) {
  return (
    <div className="empty">
      <div className="empty-card">
        <div className="logo big">⑂</div>
        <h1>Every agent, one canvas</h1>
        <p>
          A board points at a project folder. Each prompt becomes a card. Reply to keep going, or reply to any earlier card to fork the conversation
          (and the code) from that exact point.
        </p>
        <button className="btn primary" onClick={onNew}>
          Create your first board
        </button>
      </div>
    </div>
  );
}

// ---------------- board canvas ----------------

function BoardView({
  board,
  targetId,
  setTargetId,
  setOpenId,
}: {
  board: Board;
  targetId: string | null;
  setTargetId: (id: string | null) => void;
  setOpenId: (id: string | null) => void;
}) {
  const store = useStore();
  const rf = useReactFlow();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const items = useMemo(() => Object.values(store.nodes).filter((n) => n.boardId === board.id), [store.nodes, board.id]);

  const onOpen = useCallback((id: string) => setOpenId(id), [setOpenId]);
  const onReply = useCallback(
    (id: string) => {
      setTargetId(id);
      setTimeout(() => composerRef.current?.focus(), 0);
    },
    [setTargetId],
  );

  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  useEffect(() => {
    setRfNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return items.map((n) => {
        const o = old.get(n.id);
        const base = {
          id: n.id,
          type: n.kind,
          position: o?.dragging ? o.position : n.position,
          selected: o?.selected,
          measured: o?.measured,
        };
        if (n.kind === 'note')
          return { ...base, data: { node: n }, width: n.width ?? 220, height: n.height ?? 160, style: { width: n.width ?? 220, height: n.height ?? 160 } };
        return { ...base, data: { node: n, onOpen, onReply, isTarget: n.id === targetId }, width: CARD_W };
      });
    });
  }, [items, targetId, onOpen, onReply]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const n of items) {
      if (n.kind !== 'turn' || !n.parentId) continue;
      const parent = store.nodes[n.parentId] as TurnNode | undefined;
      const forked = parent && parent.branchId !== n.branchId;
      out.push({
        id: `p-${n.id}`,
        source: n.parentId,
        target: n.id,
        animated: n.status === 'running' || n.status === 'waiting',
        style: { stroke: branchColor(n.branchId), strokeWidth: 2, strokeDasharray: forked ? '6 4' : undefined },
        type: 'default',
        label: forked ? 'fork' : undefined,
        labelStyle: { fill: branchColor(n.branchId), fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: 'var(--bg)' },
      });
    }
    for (const l of board.links) out.push({ id: l.id, source: l.source, target: l.target, className: 'link-edge', deletable: true });
    return out;
  }, [items, board.links, store.nodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setRfNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), nds));
  }, []);

  const addNote = (pos: { x: number; y: number }) => {
    const note: NoteNode = { kind: 'note', id: uid(), boardId: board.id, text: '', color: NOTE_COLORS[0], position: pos, width: 220, height: 160, createdAt: Date.now() };
    send({ type: 'upsertNote', note });
  };

  const deleteSelected = () => {
    const sel = rfNodes.filter((n) => n.selected).map((n) => n.id);
    if (!sel.length) return;
    const turnsAffected = sel.some((id) => store.nodes[id]?.kind === 'turn');
    if (turnsAffected && !confirm('Delete the selected cards and everything branched from them? Their worktrees are removed too.')) return;
    send({ type: 'deleteNodes', ids: sel });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'Backspace' || e.key === 'Delete') deleteSelected();
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        addNote(centerPos());
      }
      if (e.key === '/' || (e.key === 'r' && !e.metaKey)) {
        e.preventDefault();
        composerRef.current?.focus();
      }
      if (e.key === 'Escape') setTargetId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const centerPos = () => {
    const el = document.querySelector('.react-flow');
    const r = el?.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2 - CARD_W / 2, y: (r?.top ?? 0) + 120 });
  };

  /** Where a new card goes: under its parent, or beside the parent's existing children. */
  const placeFor = (parentId: string | null) => {
    if (!parentId) {
      const roots = items.filter((n) => n.kind === 'turn' && !n.parentId);
      if (!roots.length) return centerPos();
      const maxX = Math.max(...items.map((n) => n.position.x + (n.kind === 'note' ? (n.width ?? 220) : CARD_W)));
      const minY = Math.min(...roots.map((n) => n.position.y));
      return { x: maxX + 80, y: minY };
    }
    const parent = store.nodes[parentId];
    const h = rf.getInternalNode(parentId)?.measured?.height ?? 320;
    const kids = items.filter((n) => n.kind === 'turn' && n.parentId === parentId);
    const y = parent.position.y + h + 70;
    if (!kids.length) return { x: parent.position.x, y };
    const right = Math.max(...items.filter((n) => Math.abs(n.position.y - y) < 400).map((n) => n.position.x));
    return { x: Math.max(right, parent.position.x) + CARD_W + 60, y };
  };

  const submit = async (prompt: string) => {
    const position = placeFor(targetId);
    try {
      const { id } = await request<{ id: string }>({ type: 'send', boardId: board.id, parentId: targetId, prompt, position });
      setTargetId(id);
      rf.setCenter(position.x + CARD_W / 2, position.y + 220, { zoom: rf.getZoom() < 0.6 ? 0.9 : rf.getZoom(), duration: 400 });
      return true;
    } catch (err: any) {
      toast(err.message, 'error');
      return false;
    }
  };

  const target = targetId ? (store.nodes[targetId] as TurnNode | undefined) : undefined;

  return (
    <div className="board">
      <BoardBar board={board} onNote={() => addNote(centerPos())} />
      <div className="canvas">
        <ReactFlow
          nodes={rfNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={(_, __, nodes) => send({ type: 'move', moves: nodes.map((n) => ({ id: n.id, position: n.position })) })}
          onNodeClick={(_, n) => {
            const node = store.nodes[n.id];
            if (node?.kind === 'turn' && node.status !== 'running' && node.status !== 'waiting' && node.sessionId) setTargetId(n.id);
          }}
          onNodeDoubleClick={(_, n) => store.nodes[n.id]?.kind === 'turn' && setOpenId(n.id)}
          onPaneClick={(e) => {
            if (e.detail === 2) addNote(rf.screenToFlowPosition({ x: e.clientX - 110, y: e.clientY - 20 }));
            else setTargetId(null);
          }}
          onConnect={(c) => {
            if (!c.source || !c.target || c.source === c.target) return;
            send({ type: 'updateBoard', id: board.id, patch: { links: [...board.links, { id: uid(), source: c.source, target: c.target }] } });
          }}
          onEdgesDelete={(eds) => {
            const gone = new Set(eds.map((e) => e.id));
            send({ type: 'updateBoard', id: board.id, patch: { links: board.links.filter((l) => !gone.has(l.id)) } });
          }}
          deleteKeyCode={null}
          zoomOnDoubleClick={false}
          minZoom={0.1}
          maxZoom={2}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
          colorMode="system"
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'note' ? ((n.data as any).node.color as string) : branchColor((n.data as any).node.branchId))} />
        </ReactFlow>
        {items.length === 0 && (
          <div className="canvas-hint">
            Type a prompt below to start a thread. Double-click anywhere for a note.
          </div>
        )}
      </div>
      <Composer ref={composerRef} target={target} board={board} onSubmit={submit} onClear={() => setTargetId(null)} />
    </div>
  );
}

function BoardBar({ board, onNote }: { board: Board; onNote: () => void }) {
  const [editingName, setEditingName] = useState(false);
  return (
    <div className="board-bar">
      {editingName ? (
        <input
          className="name-input"
          autoFocus
          defaultValue={board.name}
          onBlur={(e) => {
            setEditingName(false);
            if (e.target.value.trim()) send({ type: 'updateBoard', id: board.id, patch: { name: e.target.value.trim() } });
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <h2 onDoubleClick={() => setEditingName(true)} title="Double-click to rename">
          {board.name}
        </h2>
      )}
      <span className="muted path" title={board.cwd}>
        {board.cwd}
      </span>
      <span className="pill">{board.isolation === 'worktree' ? 'Worktree per branch' : 'Same folder'}</span>
      <span className="spacer" />
      <label className="field-inline">
        Permissions
        <select
          value={board.permissionMode}
          onChange={(e) => send({ type: 'updateBoard', id: board.id, patch: { permissionMode: e.target.value as PermissionMode } })}
          title={MODES.find((m) => m.value === board.permissionMode)?.hint}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field-inline">
        Model
        <input
          className="model-input"
          placeholder="default"
          defaultValue={board.model ?? ''}
          onBlur={(e) => send({ type: 'updateBoard', id: board.id, patch: { model: e.target.value.trim() || undefined } })}
        />
      </label>
      <button className="btn" onClick={onNote}>
        + Note
      </button>
      <button
        className="btn ghost danger-text"
        onClick={() => confirm(`Delete board "${board.name}"? All its cards and worktrees are removed.`) && send({ type: 'deleteBoard', id: board.id })}
      >
        Delete
      </button>
    </div>
  );
}

const Composer = ({
  ref,
  target,
  board,
  onSubmit,
  onClear,
}: {
  ref: React.Ref<HTMLTextAreaElement>;
  target?: TurnNode;
  board: Board;
  onSubmit: (p: string) => Promise<boolean>;
  onClear: () => void;
}) => {
  const { branches } = useStore();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const isFork = target && branches[target.branchId]?.headNodeId !== target.id;
  const targetBusy = target && (target.status === 'running' || target.status === 'waiting');

  const go = async () => {
    if (!text.trim() || busy || targetBusy) return;
    setBusy(true);
    if (await onSubmit(text)) setText('');
    setBusy(false);
  };

  return (
    <div className="composer">
      <div className="composer-target">
        {target ? (
          <>
            <span className="pill" style={{ borderColor: branchColor(target.branchId) }}>
              {isFork ? '⑂ Fork from' : '↳ Continue'}
            </span>
            <span className="target-text">{target.prompt}</span>
            {targetBusy && <span className="muted">Still running. You can type now and send when it finishes.</span>}
            <button className="btn ghost small" onClick={onClear} title="Esc">
              New thread instead
            </button>
          </>
        ) : (
          <>
            <span className="pill">＋ New thread</span>
            <span className="muted">
              in {board.name}. Click a finished card to reply or fork from it.
            </span>
          </>
        )}
      </div>
      <div className="composer-row">
        <textarea
          ref={ref}
          value={text}
          rows={Math.min(8, Math.max(2, text.split('\n').length))}
          placeholder={target ? 'Tell the agent what to do next…' : 'What should a new agent work on?'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              go();
            }
            if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
          }}
        />
        <button className="btn primary send" disabled={!text.trim() || busy || !!targetBusy} onClick={go}>
          {busy ? 'Starting…' : 'Send'}
          <span className="kbd">⌘↵</span>
        </button>
      </div>
    </div>
  );
};

// ---------------- detail drawer ----------------

function Drawer({ node, onClose }: { node: TurnNode; onClose: () => void }) {
  const { branches, boards } = useStore();
  const branch = branches[node.branchId];
  const board = boards.find((b) => b.id === node.boardId);
  const [tab, setTab] = useState<'log' | 'diff'>('log');
  const [diff, setDiff] = useState<string | null>(null);

  useEffect(() => {
    setDiff(null);
    if (tab === 'diff') request<string>({ type: 'diff', nodeId: node.id }).then(setDiff, (e) => setDiff(`Could not load diff: ${e.message}`));
  }, [tab, node.id, node.commit]);

  const cmd = node.sessionId && branch ? `cd ${JSON.stringify(branch.cwd)} && claude --resume ${node.sessionId} --fork-session` : '';

  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className={`dot ${node.status}`} />
        <b>{STATUS_LABEL[node.status]}</b>
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="drawer-prompt">{node.prompt}</div>

      <div className="meta">
        <div>
          <span className="muted">Branch</span> {branch?.gitBranch ?? node.branchId}
        </div>
        <div>
          <span className="muted">Folder</span> <span className="mono">{branch?.cwd ?? board?.cwd}</span>
        </div>
        {node.sessionId && (
          <div>
            <span className="muted">Session</span> <span className="mono">{node.sessionId}</span>
          </div>
        )}
        {node.commit && (
          <div>
            <span className="muted">Checkpoint</span> <span className="mono">{node.commit.slice(0, 10)}</span>
          </div>
        )}
        <div>
          <span className="muted">Cost</span> {money(node.costUsd) || '…'} {node.durationMs ? `· ${(node.durationMs / 1000).toFixed(0)}s` : ''}
        </div>
      </div>

      <div className="drawer-actions">
        <button className="btn" onClick={() => send({ type: 'openEditor', nodeId: node.id })}>
          Open folder in editor
        </button>
        {cmd && (
          <button
            className="btn"
            onClick={() => navigator.clipboard.writeText(cmd).then(() => toast('Command copied. Paste it in a terminal to take over this point.'))}
          >
            Copy terminal command
          </button>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>
          Transcript
        </button>
        <button className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')} disabled={!node.commit}>
          Changes
        </button>
      </div>

      <div className="drawer-body">
        {tab === 'log' ? (
          <>
            {node.events.map((e, i) =>
              e.t === 'text' ? (
                <Md key={i} text={e.text} />
              ) : e.t === 'thinking' ? (
                <details key={i} className="thinking-block">
                  <summary>Thinking</summary>
                  <div className="text muted">{e.text}</div>
                </details>
              ) : (
                <details key={i} className="tool-block">
                  <summary>
                    <ToolLine e={e} cwd={branch?.cwd} />
                  </summary>
                  <div className="tool-detail-label">Input</div>
                  <pre>{JSON.stringify(e.input, null, 2)}</pre>
                  {e.result != null && (
                    <>
                      <div className="tool-detail-label">Result</div>
                      <pre className={e.isError ? 'err' : ''}>{e.result}</pre>
                    </>
                  )}
                </details>
              ),
            )}
            {node.error && <div className="error-box">{node.error}</div>}
          </>
        ) : diff == null ? (
          <div className="muted">Loading…</div>
        ) : diff === '' ? (
          <div className="muted">No changes in this turn.</div>
        ) : (
          <pre className="diff">
            {diff.split('\n').map((l, i) => (
              <div
                key={i}
                className={
                  l.startsWith('+++') || l.startsWith('---') ? 'meta-line' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : l.startsWith('diff ') ? 'file' : ''
                }
              >
                {l || ' '}
              </div>
            ))}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---------------- new board ----------------

function NewBoard({ onClose, onCreated }: { onClose: () => void; onCreated: (b: Board) => void }) {
  const { home } = useStore();
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [isolation, setIsolation] = useState<Isolation>('worktree');
  const [mode, setMode] = useState<PermissionMode>('acceptEdits');
  const [browse, setBrowse] = useState<{ dir: string; parent: string; entries: string[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const open = (p: string) => request<{ dir: string; parent: string; entries: string[] }>({ type: 'listDir', path: p }).then(setBrowse, (e) => setError(e.message));

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const b = await request<Board>({ type: 'createBoard', name, cwd, isolation, permissionMode: mode });
      onCreated(b);
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h3>New board</h3>
        <label className="field">
          Project folder
          <div className="row">
            <input autoFocus value={cwd} placeholder={`${home || '~'}/code/my-app`} onChange={(e) => setCwd(e.target.value)} />
            <button className="btn" onClick={() => open(cwd || home || '~')}>
              Browse
            </button>
          </div>
        </label>
        {browse && (
          <div className="browser">
            <div className="browser-head">
              <button className="btn ghost small" onClick={() => open(browse.parent)}>
                ↑ Up
              </button>
              <span className="mono muted">{browse.dir}</span>
              <span className="spacer" />
              <button
                className="btn primary small"
                onClick={() => {
                  setCwd(browse.dir);
                  setBrowse(null);
                }}
              >
                Use this folder
              </button>
            </div>
            <div className="browser-list">
              {browse.entries.map((e) => (
                <button key={e} className="browser-item" onClick={() => open(`${browse.dir}/${e}`)}>
                  📁 {e}
                </button>
              ))}
              {browse.entries.length === 0 && <div className="muted small-pad">No subfolders</div>}
            </div>
          </div>
        )}
        <label className="field">
          Name
          <input value={name} placeholder={cwd.split('/').filter(Boolean).pop() || 'My project'} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field">
          How branches share code
          <div className="choice">
            <button className={isolation === 'worktree' ? 'on' : ''} onClick={() => setIsolation('worktree')}>
              <b>Worktree per branch</b>
              <span>Each fork gets its own git worktree and a checkpoint commit per turn. Forks never step on each other. Needs a git repo.</span>
            </button>
            <button className={isolation === 'none' ? 'on' : ''} onClick={() => setIsolation('none')}>
              <b>Same folder</b>
              <span>Every agent edits the folder directly. Works anywhere, but forks share files.</span>
            </button>
          </div>
        </div>
        <label className="field">
          Permissions
          <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}: {m.hint}
              </option>
            ))}
          </select>
        </label>
        {error && <div className="error-box">{error}</div>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!cwd.trim() || busy} onClick={create}>
            {busy ? 'Creating…' : 'Create board'}
          </button>
        </div>
      </div>
    </div>
  );
}
