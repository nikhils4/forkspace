import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { openThreadNote } from './ThreadNotes.tsx';
import { CommentsPanel, openCount, setCommentsPanel, startComment, useCommentsPanel } from './Comments.tsx';
import { Beacons } from './Beacons.tsx';
import { clearReady, useReady } from './review.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Board, NoteNode, TurnNode } from '../shared/types.ts';
import { composerFocus } from './Composer.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { pickShot, snapPreview, uploadShot } from './Shots.tsx';
import { Icon } from './icons.tsx';
import { CARD_W, heights } from './layout.ts';
import { NOTE_COLORS, NoteCard, TurnCard, branchColor } from './nodes.tsx';
import { openTerminalFor, request, send, toast, useStore } from './store.ts';
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
  // Notes filed away in Notes stay off the canvas.
  const items = useMemo(() => Object.values(store.nodes).filter((n) => n.boardId === board.id && !(n.kind === 'note' && n.filed)), [store.nodes, board.id]);

  const commentsOpen = useCommentsPanel();
  const openComments = useMemo(() => items.reduce((a, n) => a + (n.kind === 'turn' ? openCount(n) : 0), 0), [items]);

  const onReply = useCallback(
    (id: string | null) => {
      setTargetId(id);
      setTimeout(() => composerFocus.current?.focus(), 0);
    },
    [setTargetId],
  );

  /** True when an earlier step on this card's path was marked complete. */
  const belowCompleted = (n: TurnNode) => {
    for (let p = n.parentId ? store.nodes[n.parentId] : undefined; p && isTurn(p); p = p.parentId ? store.nodes[p.parentId] : undefined) if (p.completed) return true;
    return false;
  };

  /** Every screenshot in a thread, oldest first: the newest becomes the thread's cover. */
  const threadShots = (rootId: string) => {
    const out: { id: string; node: TurnNode; at: number }[] = [];
    const walk = (id: string) => {
      const t = store.nodes[id];
      if (!isTurn(t)) return;
      (t.shots ?? []).forEach((s, i) => out.push({ id: s, node: t, at: (t.finishedAt ?? t.createdAt) + i }));
      for (const n of items) if (isTurn(n) && n.parentId === id) walk(n.id);
    };
    walk(rootId);
    return out.length ? out.sort((a, b) => a.at - b.at).map(({ id, node }) => ({ id, node })) : undefined;
  };

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
          // Notes always sit above cards, so a new one never hides behind them.
          return { ...base, data: { node: n }, width: w, height: h, style: { width: w, height: h }, zIndex: 1000 };
        }
        return { ...base, data: { node: n, onOpen: openDetails, onReply, isTarget: n.id === targetId, faded: belowCompleted(n), cover: n.parentId ? undefined : threadShots(n.id) }, width: CARD_W };
      });
    });
  }, [items, targetId, openDetails, onReply]);

  /**
   * Glide a card to the middle of the part of the canvas you can see (above the floating composer).
   * Zoomed far out, come back in so it is readable; a card taller than the view lines up its top instead.
   */
  const centerOn = useCallback(
    (id: string) => {
      const internal = rf.getInternalNode(id);
      const n = store.nodes[id];
      if (!internal || !n) return;
      const el = document.querySelector('.pane.on .canvas') as HTMLElement | null;
      const viewH = el?.clientHeight ?? 700;
      // The details panel floats over the right side: centre in the part you can still see.
      const cr = el?.getBoundingClientRect();
      // So does the Comments panel: whichever reaches further left sets the edge.
      const over = [...document.querySelectorAll('.drawer, .pane.on .cmt-panel')].map((e) => e.getBoundingClientRect()).filter((r) => r.width);
      const dr = over.sort((a, b) => a.left - b.left)[0];
      const visibleW = cr && dr && dr.left < cr.right && dr.left > cr.left + 200 ? dr.left - cr.left - 12 : (cr?.width ?? 0);
      const shiftX = cr ? (cr.width - visibleW) / 2 : 0;
      const composer = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--composer-h')) || 120;
      const visibleH = Math.max(200, viewH - composer - 16);
      const zoom = rf.getZoom() < 0.55 ? (mobile ? 0.75 : 0.9) : rf.getZoom();
      const w = internal.measured?.width ?? CARD_W;
      // Zoomed far out the card is drawn short; use its remembered full-size height.
      const h = heights.get(id) ?? internal.measured?.height ?? 320;
      const pos = internal.internals.positionAbsolute;
      // Point (in canvas units) that should land in the middle of the visible area.
      const focusY = h * zoom > visibleH * 0.9 ? pos.y + (visibleH * 0.45) / zoom - 24 / zoom : pos.y + h / 2;
      // setCenter centres in the whole canvas; shift so it centres above the composer instead.
      rf.setCenter(pos.x + w / 2 + shiftX / zoom, focusY + composer / 2 / zoom, { zoom, duration: 480 });
    },
    [rf, store.nodes, mobile],
  );

  /**
   * Fit every card into the part of the canvas you can see (above the floating composer), centred.
   * React Flow's own fitView centres in the whole canvas, so things sat high and to one side.
   */
  const fitVisible = useCallback(
    (duration = 0) => {
      const nodes = rf.getNodes();
      const el = document.querySelector('.pane.on .canvas') as HTMLElement | null;
      if (!nodes.length || !el || !el.clientWidth) return false;
      const nb = rf.getNodesBounds(nodes);
      // Leave room for each thread's circle and title above its first card.
      const b = { ...nb, y: nb.y - 110, height: nb.height + 110 };
      const composer = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--composer-h')) || 120;
      const W = el.clientWidth;
      const H = Math.max(200, el.clientHeight - composer - 16);
      const pad = mobile ? 24 : 64;
      const zoom = Math.max(0.1, Math.min((W - pad * 2) / Math.max(b.width, 1), (H - pad * 2) / Math.max(b.height, 1), mobile ? 0.8 : 1));
      rf.setViewport({ x: W / 2 - (b.x + b.width / 2) * zoom, y: H / 2 - (b.y + b.height / 2) * zoom, zoom }, { duration });
      return true;
    },
    [rf, mobile],
  );

  // Opening a board (or switching to the canvas for the first time) centres its cards.
  const fittedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!active || fittedFor.current === board.id) return;
    if (!items.length) {
      fittedFor.current = board.id;
      return;
    }
    // Wait until the cards are drawn and measured.
    if (!rfNodes.length || rfNodes.some((n) => !n.measured?.width)) return;
    const t = setTimeout(() => fitVisible() && (fittedFor.current = board.id), 30);
    return () => clearTimeout(t);
  }, [active, board.id, rfNodes, items.length, fitVisible]);

  // Pan to a card when asked (new card sent, sidebar click, notification tap). A card you just
  // sent can take a moment to arrive and be measured, so keep trying briefly.
  // While it works, the view follows it as it grows, until you move the view yourself.
  const readyIds = useReady();
  const following = useRef<{ id: string; at: number; h: number } | null>(null);
  const centerRef = useRef(centerOn);
  centerRef.current = centerOn;
  const nodesRef = useRef(store.nodes);
  nodesRef.current = store.nodes;
  useEffect(() => {
    if (!focus) return;
    let tries = 0;
    let t: ReturnType<typeof setTimeout>;
    const go = () => {
      const internal = rf.getInternalNode(focus.id);
      if (!internal?.measured?.width || !nodesRef.current[focus.id]) {
        if (tries++ < 40) t = setTimeout(go, 75);
        return;
      }
      // The latest centerOn: the one from when you pressed send doesn't know the new card yet.
      centerRef.current(focus.id);
      following.current = { id: focus.id, at: Date.now(), h: internal.measured.height ?? 0 };
    };
    t = setTimeout(go, 40);
    return () => clearTimeout(t);
  }, [focus?.n]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    // The path from the thread's start to the card you're on stands out; the rest steps back.
    const onPath = new Set<string>();
    for (let t = targetId ? store.nodes[targetId] : undefined; t && isTurn(t); t = t.parentId ? store.nodes[t.parentId] : undefined) onPath.add(t.id);
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
        className: onPath.has(n.id) ? 'on-path' : onPath.size ? 'off-path' : undefined,
        style: { stroke: c, strokeWidth: onPath.has(n.id) ? 2.5 : 1.5, strokeOpacity: onPath.has(n.id) ? 1 : onPath.size ? 0.4 : 0.7, strokeDasharray: forked ? '5 5' : undefined },
        label: forked ? 'fork' : undefined,
        labelStyle: { fill: c, fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: 'var(--bg)' },
        labelBgPadding: [6, 3],
        labelBgBorderRadius: 6,
      });
    }
    const here = new Set(items.map((n) => n.id));
    for (const l of board.links) if (here.has(l.source) && here.has(l.target)) out.push({ id: l.id, source: l.source, target: l.target, className: 'link-edge' });
    return out;
  }, [items, board.links, store.nodes, targetId]);

  // ---- undo / redo for moving things on the canvas (⌘Z, ⇧⌘Z) ----
  type Moves = { id: string; position: { x: number; y: number } }[];
  const history = useRef<{ undo: { before: Moves; after: Moves }[]; redo: { before: Moves; after: Moves }[] }>({ undo: [], redo: [] });
  const dragFrom = useRef<Moves>([]);
  const record = (before: Moves, after: Moves) => {
    const moved = after.some((a) => {
      const b = before.find((x) => x.id === a.id);
      return !b || Math.abs(b.position.x - a.position.x) > 0.5 || Math.abs(b.position.y - a.position.y) > 0.5;
    });
    if (!moved) return;
    history.current.undo.push({ before, after });
    if (history.current.undo.length > 100) history.current.undo.shift();
    history.current.redo = [];
  };
  const applyMoves = (moves: Moves) => {
    const live = moves.filter((m) => store.nodes[m.id]);
    if (!live.length) return false;
    const at = new Map(live.map((m) => [m.id, m.position]));
    setRfNodes((nds) => nds.map((n) => (at.has(n.id) ? { ...n, position: at.get(n.id)! } : n)));
    send({ type: 'move', moves: live });
    return true;
  };
  const undoMove = (redo = false) => {
    const h = history.current;
    const step = (redo ? h.redo : h.undo).pop();
    if (!step) return toast(redo ? 'Nothing to redo' : 'Nothing to undo');
    (redo ? h.undo : h.redo).push(step);
    applyMoves(redo ? step.after : step.before);
  };
  const posOf = (id: string) => {
    const n = store.nodes[id];
    return n?.position ? { x: n.position.x, y: n.position.y } : { x: 0, y: 0 };
  };

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Only remember full-size heights: zoomed far out, cards are drawn as short title cards.
    const full = rf.getZoom() >= 0.55;
    for (const c of changes) if (full && c.type === 'dimensions' && c.dimensions) heights.set(c.id, c.dimensions.height);
    // Keep the card you're watching in the middle as it grows (at most every 1.2 s).
    const f = following.current;
    if (f)
      for (const c of changes)
        if (c.type === 'dimensions' && c.id === f.id && c.dimensions && Math.abs(c.dimensions.height - f.h) > 30 && Date.now() - f.at > 1200) {
          const n = nodesRef.current[f.id];
          if (!n || !isTurn(n) || !isLive(n)) {
            following.current = null;
            break;
          }
          f.h = c.dimensions.height;
          f.at = Date.now();
          setTimeout(() => centerRef.current(f.id), 0);
        }
    setRfNodes((nds) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), nds));
  }, []);

  const centerPos = () => {
    const r = document.querySelector('.react-flow')?.getBoundingClientRect();
    return rf.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 800) / 2 - 110, y: (r?.top ?? 0) + (r?.height ?? 600) / 2 - 80 });
  };

  /** Nearest spot to `pos` where a new note doesn't cover a card or another note. */
  const freeSpot = (pos: { x: number; y: number }, w = 220, h = 160) => {
    const boxes = rf.getNodes().map((n) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? n.width ?? CARD_W, h: n.measured?.height ?? n.height ?? 300 }));
    const clear = (x: number, y: number) => boxes.every((b) => x + w + 16 < b.x || x > b.x + b.w + 16 || y + h + 16 < b.y || y > b.y + b.h + 16);
    if (clear(pos.x, pos.y)) return pos;
    for (let r = 1; r < 40; r++)
      for (let a = 0; a < 16; a++) {
        const x = pos.x + Math.cos((a / 16) * Math.PI * 2) * r * 48;
        const y = pos.y + Math.sin((a / 16) * Math.PI * 2) * r * 48;
        if (clear(x, y)) return { x: Math.round(x), y: Math.round(y) };
      }
    return pos;
  };

  const addNote = (at?: { x: number; y: number }) => {
    const pos = freeSpot(at ?? centerPos());
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
    record(moves.map((m) => ({ id: m.id, position: posOf(m.id) })), moves.map((m) => ({ id: m.id, position: m.position })));
    send({ type: 'move', moves });
    setTimeout(() => fitVisible(500), 120);
  };

  const deleteSelected = () => {
    const sel = rfNodes.filter((n) => n.selected).map((n) => n.id);
    if (!sel.length) return;
    if (sel.some((id) => isTurn(store.nodes[id])) && !confirm('Delete the selected cards and every branch that grew from them? Their worktrees are removed too.')) return;
    send({ type: 'deleteNodes', ids: sel });
  };

  // ---- context menu: right-click, or long-press on touch ----
  const [menu, setMenu] = useState<{ x: number; y: number; id: string | null } | null>(null);
  const swallowClick = useRef(false);
  const press = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  /** Places that keep the browser's own menu: buttons, links, and text you are typing in. */
  const ownMenu = (t: EventTarget | null) => {
    const el = t as HTMLElement;
    if (el.closest('button, a, input, .perm, .canvas-tools, .ctx')) return true;
    // In a note's text, keep the browser menu only when text is selected (copy, look up, ...).
    const ta = el.closest('textarea');
    return !!ta && ta.selectionStart !== ta.selectionEnd;
  };
  const openMenuAt = (x: number, y: number, target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest?.('.react-flow__node') as HTMLElement | null;
    setMenu({ x, y, id: el?.dataset.id ?? null });
  };
  const onPointerDown = (e: React.PointerEvent) => {
    swallowClick.current = false;
    if (e.pointerType !== 'touch' || ownMenu(e.target)) return;
    const { clientX: x, clientY: y, target } = e;
    clearTimeout(press.current?.t);
    press.current = {
      x,
      y,
      t: setTimeout(() => {
        press.current = null;
        swallowClick.current = true;
        navigator.vibrate?.(8);
        openMenuAt(x, y, target);
      }, 480),
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) {
      clearTimeout(p.t);
      press.current = null;
    }
  };
  const endPress = () => {
    clearTimeout(press.current?.t);
    press.current = null;
  };

  const copy = (text: string, what: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast(`${what} copied`),
      () => toast('Could not copy', 'error'),
    );

  /** Every step that grew from this one, itself included. */
  const subtree = (id: string) => {
    const out = [id];
    for (let i = 0; i < out.length; i++) for (const n of items) if (isTurn(n) && n.parentId === out[i]) out.push(n.id);
    return out;
  };

  const menuItems = (id: string | null): MenuItem[] => {
    const flowPos = menu ? rf.screenToFlowPosition({ x: menu.x - 110, y: menu.y - 24 }) : centerPos();
    const selected = rfNodes.filter((n) => n.selected).map((n) => n.id);
    if (id && selected.length > 1 && selected.includes(id)) {
      const turns = selected.filter((s) => isTurn(store.nodes[s]));
      return [
        { label: 'Tidy up', icon: 'grid', onClick: tidy },
        'sep',
        {
          label: `Delete ${selected.length} selected`,
          icon: 'trash',
          danger: true,
          confirm: turns.length ? 'Click again: branches go too' : undefined,
          onClick: () => send({ type: 'deleteNodes', ids: selected }),
        },
      ];
    }
    const node = id ? store.nodes[id] : null;
    if (!node) {
      return [
        { label: 'New note here', icon: 'note', hint: 'N', onClick: () => addNote(flowPos) },
        { label: 'New thread', icon: 'plus', onClick: () => onReply(null) },
        'sep',
        { label: 'Tidy up', icon: 'grid', onClick: tidy },
        { label: 'Fit everything', icon: 'canvas', onClick: () => fitVisible(400) },
      ];
    }
    if (!isTurn(node)) {
      return [
        { swatches: NOTE_COLORS, current: node.color, onPick: (c) => send({ type: 'upsertNote', note: { ...node, color: c } }) },
        'sep',
        {
          label: 'Duplicate',
          icon: 'copy',
          onClick: () => send({ type: 'upsertNote', note: { ...node, id: uid(), position: { x: node.position.x + 32, y: node.position.y + 32 }, createdAt: Date.now() } }),
        },
        { label: 'Copy text', icon: 'file', disabled: !node.text.trim(), onClick: () => copy(node.text, 'Note') },
        { label: 'Move to Notes', icon: 'folder', onClick: () => (send({ type: 'upsertNote', note: { ...node, filed: true } }), toast('Moved to Notes')) },
        'sep',
        { label: 'Delete note', icon: 'trash', danger: true, onClick: () => send({ type: 'deleteNodes', ids: [node.id] }) },
      ];
    }
    const live = isLive(node);
    const isHead = store.branches[node.branchId]?.headNodeId === node.id;
    const gone = subtree(node.id).length;
    const out: MenuItem[] = [];
    if (!node.parentId) out.push({ label: node.completed ? 'Reopen thread' : 'Mark thread complete', icon: 'check', onClick: () => send({ type: 'setCompleted', nodeId: node.id, completed: !node.completed }) });
    if (live) out.push({ label: 'Stop', icon: 'stop', onClick: () => send({ type: 'stop', nodeId: node.id }) });
    else if (node.sessionId) out.push({ label: isHead ? 'Reply' : 'Branch from here', icon: isHead ? 'chat' : 'branch', hint: 'R', onClick: () => onReply(node.id) });
    out.push(
      { label: 'Add comment', icon: 'comment', onClick: () => startComment(node.id) },
      { label: 'Open details', icon: 'external', onClick: () => openDetails(node.id) },
      { label: 'Terminal here', icon: 'terminal', hint: 'This card’s folder', onClick: () => openTerminalFor(node.branchId) },
      { label: 'Center', icon: 'canvas', onClick: () => centerOn(node.id) },
      'sep',
      ...(store.branches[node.branchId]?.note?.markdown ? [{ label: 'Thread notes', icon: 'note' as const, onClick: () => openThreadNote(node.branchId) }] : []),
      { label: 'Copy prompt', icon: 'copy', onClick: () => copy(node.prompt, 'Prompt') },
      ...(board.previewUrl ? [{ label: 'Screenshot my app now', icon: 'external' as const, onClick: () => snapPreview(node.id) }] : []),
      { label: 'Add screenshot…', icon: 'file', hint: '⌘V', onClick: () => pickShot(node.id) },
      {
        label: 'Open in editor',
        icon: 'code',
        onClick: () =>
          request<string>({ type: 'openEditor', nodeId: node.id }).then(
            (app) => toast(`Opened in ${app}`),
            (e: Error) => toast(e.message, 'error'),
          ),
      },
      'sep',
      {
        label: gone > 1 ? `Delete with ${gone - 1} after it` : 'Delete step',
        icon: 'trash',
        danger: true,
        disabled: live,
        confirm: gone > 1 ? `Click again to delete ${gone} steps` : 'Click again to delete',
        onClick: () => send({ type: 'deleteNodes', ids: [node.id] }),
      },
    );
    return out;
  };

  useEffect(() => {
    if (!active) setMenu(null);
  }, [active]);

  // Paste a screenshot (⌘V) onto the selected step, or the one you're replying to.
  useEffect(() => {
    if (!active) return;
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable]')) return;
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      if (rfNodes.some((n) => n.selected && store.nodes[n.id]?.kind === 'note')) return; // the note asks for itself
      const sel = rfNodes.find((n) => n.selected && isTurn(store.nodes[n.id]))?.id ?? targetId;
      if (!sel || !isTurn(store.nodes[sel])) return toast('Select a step first, then paste the screenshot.');
      e.preventDefault();
      uploadShot(sel, file).catch((err: Error) => toast(err.message, 'error'));
    };
    addEventListener('paste', onPaste);
    return () => removeEventListener('paste', onPaste);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!active) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        return undoMove(e.shiftKey);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        return undoMove(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        return setRfNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
      }
      if (e.shiftKey && (e.key === '!' || e.code === 'Digit1')) {
        e.preventDefault();
        return fitVisible(450);
      }
      // Walk a thread with the arrow keys: up to the step before, down to the next, sideways to other branches.
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && !e.metaKey && !e.altKey) {
        const from = targetId && isTurn(store.nodes[targetId]) ? (store.nodes[targetId] as TurnNode) : null;
        const turns = items.filter(isTurn) as TurnNode[];
        let next: TurnNode | undefined;
        if (!from) next = turns.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
        else if (e.key === 'ArrowUp') next = from.parentId ? (store.nodes[from.parentId] as TurnNode) : undefined;
        else if (e.key === 'ArrowDown') {
          const kids = turns.filter((t) => t.parentId === from.id);
          // Prefer the step that continues this branch, then the newest fork.
          next = kids.find((k) => k.branchId === from.branchId) ?? kids.sort((a, b) => b.createdAt - a.createdAt)[0];
        } else {
          const sibs = turns.filter((t) => t.parentId === from.parentId).sort((a, b) => a.position.x - b.position.x);
          const i = sibs.findIndex((t) => t.id === from.id);
          next = sibs[i + (e.key === 'ArrowRight' ? 1 : -1)];
        }
        e.preventDefault();
        if (!next) return;
        setTargetId(next.id);
        setRfNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === next!.id })));
        if (document.querySelector('.drawer')) openDetails(next.id);
        setTimeout(() => centerOn(next!.id), 30);
        return;
      }
      if (e.key === 'Enter' && targetId && isTurn(store.nodes[targetId])) {
        e.preventDefault();
        openDetails(targetId);
        return;
      }
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
    <div
      className="canvas"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onClickCapture={(e) => {
        if (swallowClick.current) {
          swallowClick.current = false;
          e.stopPropagation();
        }
      }}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) e.preventDefault();
      }}
      onDrop={(e) => {
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
        if (!file) return;
        e.preventDefault();
        // Dropped on a card: attach to it.
        const id = ((e.target as HTMLElement).closest('.react-flow__node-turn') as HTMLElement | null)?.dataset.id;
        if (!id) return toast('Drop the screenshot onto a card.');
        uploadShot(id, file).catch((err: Error) => toast(err.message, 'error'));
      }}
      onContextMenu={(e) => {
        // Right-click on a card or the canvas. Typing areas keep the browser's own menu.
        if (ownMenu(e.target)) return;
        e.preventDefault();
        if (press.current || swallowClick.current) return; // a long-press already opened ours
        openMenuAt(e.clientX, e.clientY, e.target);
      }}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={(_, __, nodes) => (dragFrom.current = nodes.map((n) => ({ id: n.id, position: posOf(n.id) })))}
        onNodeDragStop={(_, __, nodes) => {
          const after = nodes.map((n) => ({ id: n.id, position: n.position }));
          record(dragFrom.current, after);
          send({ type: 'move', moves: after });
        }}
        onNodeClick={(e, n) => {
          const node = store.nodes[n.id];
          if (!isTurn(node)) return; // notes: clicking is for typing, don't move the view
          clearReady(n.id); // You looked at it: no longer waiting for review.
          // ⇧ or ⌘ click adds to the selection (to move several at once); nothing else happens.
          if (e.shiftKey || e.metaKey || e.ctrlKey) return;
          // Buttons, links, checkboxes and approvals inside the card do their own thing.
          if ((e.target as HTMLElement).closest('button, a, input, textarea, .perm, .shot-thumb, .card-comments')) {
            if (!isLive(node) && node.sessionId) setTargetId(n.id);
            return;
          }
          // Anywhere else on the card: select it, open its details, and bring it to the middle of
          // what's still visible (left of the panel, above the message box).
          if (!isLive(node) && node.sessionId) setTargetId(n.id);
          openDetails(n.id);
          setTimeout(() => centerOn(n.id), 60);
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
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        panOnScroll={!mobile}
        // Desktop: drag on empty canvas draws a box to select several cards; pan with two fingers,
        // the scroll wheel, Space + drag or the middle mouse button. Phones: drag pans.
        selectionOnDrag={!mobile}
        panOnDrag={mobile ? true : [1]}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={['Meta', 'Shift', 'Control']}
        selectionKeyCode={null}
        panActivationKeyCode="Space"
        onlyRenderVisibleElements={false}
        disableKeyboardA11y
        // You moved the view yourself: stop following the working card.
        onMoveStart={(e) => {
          if (e) following.current = null;
        }}
        // Lets a working card's glow stay the same size on screen at any zoom.
        onMove={(_, vp) => (document.querySelector('.pane.on .canvas') as HTMLElement | null)?.style.setProperty('--inv-zoom', String(1 / vp.zoom))}
        onInit={(inst) => (document.querySelector('.pane.on .canvas') as HTMLElement | null)?.style.setProperty('--inv-zoom', String(1 / inst.getZoom()))}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.3} />
        <Beacons
          live={items.filter((n): n is TurnNode => isTurn(n) && isLive(n))}
          ready={items.filter((n): n is TurnNode => isTurn(n) && !isLive(n) && readyIds.has(n.id))}
          notes={items.filter((n): n is NoteNode => n.kind === 'note')}
          onGo={(id) => {
            const n = store.nodes[id];
            if (isTurn(n)) setTargetId(n.sessionId ? id : targetId);
            centerOn(id);
          }}
        />
        {!mobile && <Controls showInteractive={false} position="bottom-left" onFitView={() => fitVisible(400)} />}
        {!mobile && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            nodeBorderRadius={6}
            nodeClassName={(n) => (n.type === 'turn' && isLive((n.data as any).node) ? `mm-live ${(n.data as any).node.status}` : '')}
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

      {menu && <ContextMenu key={`${menu.x},${menu.y}`} x={menu.x} y={menu.y} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}

      {commentsOpen && (
        <CommentsPanel
          boardId={board.id}
          onClose={() => setCommentsPanel(false)}
          onGo={(id) => {
            setTargetId(id);
            centerOn(id);
          }}
        />
      )}

      <div className="canvas-tools">
        <button className={`fab ${commentsOpen ? 'on' : ''}`} onClick={() => setCommentsPanel(!commentsOpen)} title="Comments: every comment on this board" aria-label="Comments" aria-pressed={commentsOpen}>
          <Icon name="comment" size={18} />
          {openComments > 0 && <span className="fab-count">{openComments > 99 ? '99+' : openComments}</span>}
        </button>
        <button className="fab" onClick={() => addNote()} title="New note (N)" aria-label="New note">
          <Icon name="note" size={18} />
        </button>
        <button className="fab" onClick={tidy} title="Tidy up: arrange every branch neatly" aria-label="Tidy up">
          <Icon name="grid" size={18} />
        </button>
        <button className="fab" onClick={() => fitVisible(400)} title="Fit everything" aria-label="Fit everything">
          <Icon name="canvas" size={18} />
        </button>
      </div>
    </div>
  );
}
