import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Board, NoteNode, TurnNode } from '../shared/types.ts';
import { composerFocus } from './Composer.tsx';
import { Icon } from './icons.tsx';
import { CARD_W, heights } from './layout.ts';
import { NOTE_COLORS, NoteCard, TurnCard, branchColor } from './nodes.tsx';
import { send, useStore } from './store.ts';
import { isLive, isTurn } from './tree.ts';
import { useIsMobile } from './ui.tsx';
import { useResolvedTheme } from './theme.ts';

const nodeTypes = { turn: TurnCard, note: NoteCard };
const uid = () => Math.random().toString(36).slice(2, 12);

export function Canvas({
  board,
  targetId,
  setTargetId,
  openDetails,
  focus,
  active = true,
}: {
  active?: boolean;
  board: Board;
  targetId: string | null;
  setTargetId: (id: string | null) => void;
  openDetails: (id: string) => void;
  focus: { id: string; n: number } | null;
}) {
  const store = useStore();
  const rf = useReactFlow();
  const mobile = useIsMobile();
  const theme = useResolvedTheme();
  const items = useMemo(() => Object.values(store.nodes).filter((n) => n.boardId === board.id), [store.nodes, board.id]);

  const onReply = useCallback(
    (id: string) => {
      setTargetId(id);
      setTimeout(() => composerFocus.current?.focus(), 0);
    },
    [setTargetId],
  );

  const [rfNodes, setRfNodes] = useState<Node[]>([]);
  useEffect(() => {
    setRfNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return items.map((n) => {
        const o = old.get(n.id);
        // A card without a usable position goes to the origin instead of breaking the canvas.
        const pos = n.position && Number.isFinite(n.position.x) && Number.isFinite(n.position.y) ? n.position : { x: 0, y: 0 };
        const base = { id: n.id, type: n.kind, position: o?.dragging ? o.position : pos, selected: o?.selected, measured: o?.measured };
        if (n.kind === 'note') {
          const w = n.width ?? 220;
          const h = n.height ?? 160;
          return { ...base, data: { node: n }, width: w, height: h, style: { width: w, height: h } };
        }
        return { ...base, data: { node: n, onOpen: openDetails, onReply, isTarget: n.id === targetId }, width: CARD_W };
      });
    });
  }, [items, targetId, openDetails, onReply]);

  // Pan to a card when asked (new card sent, sidebar click, notification tap).
  useEffect(() => {
    if (!focus) return;
    const n = store.nodes[focus.id];
    if (!n) return;
    const t = setTimeout(() => rf.setCenter(n.position.x + CARD_W / 2, n.position.y + 180, { zoom: Math.max(rf.getZoom(), mobile ? 0.75 : 0.9), duration: 450 }), 60);
    return () => clearTimeout(t);
  }, [focus?.n]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const n of items) {
      if (!isTurn(n) || !n.parentId) continue;
      const parent = store.nodes[n.parentId] as TurnNode | undefined;
      const forked = parent && parent.branchId !== n.branchId;
      const c = branchColor(n.branchId);
      out.push({
        id: `p-${n.id}`,
        source: n.parentId,
        target: n.id,
        animated: isLive(n),
        type: 'default',
        style: { stroke: c, strokeWidth: 1.5, strokeOpacity: 0.7, strokeDasharray: forked ? '5 5' : undefined },
        label: forked ? 'fork' : undefined,
        labelStyle: { fill: c, fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: 'var(--bg)' },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 6,
      });
    }
    for (const l of board.links) out.push({ id: l.id, source: l.source, target: l.target, className: 'link-edge' });
    return out;
  }, [items, board.links, store.nodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Only remember full-size heights: zoomed far out, cards are drawn as short title cards.
    const full = rf.getZoom() >= 0.55;
    for (const c of changes) if (full && c.type === 'dimensions' && c.dimensions) heights.set(c.id, c.dimensions.height);
    setRfNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), nds));
  }, []);

  const centerPos = () => {
    const r = document.querySelector('.react-flow')?.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2 - 110, y: (r?.top ?? 0) + (r?.height ?? 600) / 2 - 80 });
  };

  const addNote = (pos = centerPos()) => {
    const note: NoteNode = { kind: 'note', id: uid(), boardId: board.id, text: '', color: NOTE_COLORS[0], position: pos, width: 220, height: 160, createdAt: Date.now() };
    send({ type: 'upsertNote', note });
  };

  /** Lay every thread out as a neat tree: children side by side under their parent, threads left to right. */
  const tidy = () => {
    const turns = items.filter(isTurn);
    if (!turns.length) return;
    const kids = new Map<string, TurnNode[]>();
    for (const t of turns) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    for (const list of kids.values()) list.sort((a, b) => a.createdAt - b.createdAt);
    const GAP_X = 56;
    const GAP_Y = 64;
    const h = (id: string) => Math.max(heights.get(id) ?? 300, 160);
    const width = new Map<string, number>();
    const measure = (t: TurnNode): number => {
      const ch = kids.get(t.id) ?? [];
      const w = ch.length ? Math.max(CARD_W, ch.reduce((sum, c) => sum + measure(c), 0) + GAP_X * (ch.length - 1)) : CARD_W;
      width.set(t.id, w);
      return w;
    };
    const moves: { id: string; position: { x: number; y: number } }[] = [];
    const place = (t: TurnNode, left: number, y: number) => {
      const w = width.get(t.id)!;
      moves.push({ id: t.id, position: { x: Math.round(left + (w - CARD_W) / 2), y: Math.round(y) } });
      let x = left;
      for (const c of kids.get(t.id) ?? []) {
        place(c, x, y + h(t.id) + GAP_Y);
        x += width.get(c.id)! + GAP_X;
      }
    };
    const roots = turns.filter((t) => !t.parentId).sort((a, b) => a.createdAt - b.createdAt);
    const start = { x: Math.min(...roots.map((r) => r.position.x)), y: Math.min(...roots.map((r) => r.position.y)) };
    let x = start.x;
    for (const r of roots) {
      measure(r);
      place(r, x, start.y);
      x += width.get(r.id)! + GAP_X * 2.5;
    }
    send({ type: 'move', moves });
    setTimeout(() => rf.fitView({ padding: 0.15, duration: 500, maxZoom: 1 }), 120);
  };

  const deleteSelected = () => {
    const sel = rfNodes.filter((n) => n.selected).map((n) => n.id);
    if (!sel.length) return;
    if (sel.some((id) => isTurn(store.nodes[id])) && !confirm('Delete the selected cards and every branch that grew from them? Their worktrees are removed too.')) return;
    send({ type: 'deleteNodes', ids: sel });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'Backspace' || e.key === 'Delete') deleteSelected();
      if (e.key === 'n' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        addNote();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="canvas">
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={(_, __, nodes) => send({ type: 'move', moves: nodes.map((n) => ({ id: n.id, position: n.position })) })}
        onNodeClick={(_, n) => {
          const node = store.nodes[n.id];
          if (isTurn(node) && !isLive(node) && node.sessionId) setTargetId(n.id);
        }}
        onNodeDoubleClick={(_, n) => isTurn(store.nodes[n.id]) && openDetails(n.id)}
        onPaneClick={(e) => {
          if (e.detail === 2 && !mobile) addNote(rf.screenToFlowPosition({ x: e.clientX - 110, y: e.clientY - 24 }));
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
        fitViewOptions={{ maxZoom: mobile ? 0.8 : 1, padding: 0.15 }}
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        panOnScroll={!mobile}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} />
        {!mobile && <Controls showInteractive={false} position="bottom-left" />}
        {!mobile && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            nodeBorderRadius={6}
            nodeColor={(n) => (n.type === 'note' ? ((n.data as any).node.color as string) : branchColor((n.data as any).node.branchId))}
          />
        )}
      </ReactFlow>

      {items.length === 0 && (
        <div className="canvas-empty">
          <div className="canvas-empty-card">
            <Icon name="spark" size={22} />
            <div>Describe a task below to start the first thread.</div>
            <div className="faint">{mobile ? 'Tap + to drop a note anywhere.' : 'Double-click anywhere for a note. Drag or scroll to pan, pinch or ⌘-scroll to zoom.'}</div>
          </div>
        </div>
      )}

      <div className="canvas-tools">
        <button className="fab" onClick={() => addNote()} title="New note (N)" aria-label="New note">
          <Icon name="note" size={18} />
        </button>
        <button className="fab" onClick={tidy} title="Tidy up: arrange every branch neatly" aria-label="Tidy up">
          <Icon name="grid" size={18} />
        </button>
        <button className="fab" onClick={() => rf.fitView({ padding: 0.15, duration: 400, maxZoom: 1 })} title="Fit everything" aria-label="Fit everything">
          <Icon name="canvas" size={18} />
        </button>
      </div>
    </div>
  );
}
