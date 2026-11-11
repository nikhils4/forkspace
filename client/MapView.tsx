import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Board, CodeMap, MapAnswer, MapTrace, MapTraceStep, MapZoom, TableOp, TurnNode } from '../shared/types.ts';
import { currentActivity, isLive } from './tree.ts';
import { Icon } from './icons.tsx';
import { Md } from './nodes.tsx';
import { onMapProgress, request, toast, useStore } from './store.ts';
import { useResolvedTheme } from './theme.ts';
import { timeAgo, useTick } from './ui.tsx';

// The project as a map: screens, API routes, logic and data in lanes, with lines for what uses
// what. Open a card to see the files and functions inside; data models show their fields.
// Ask how something happens and it plays as a walkthrough: a sample of the data moves from
// card to card, changing as it goes, and the tables it touches light up.

type Layer = CodeMap['layers'][number];
type Item = CodeMap['items'][number];

const LANE_ORDER: Layer['kind'][] = ['screens', 'api', 'logic', 'data', 'jobs', 'shared', 'infra'];
const LANE_COLOR: Record<string, string> = {
  screens: '#f472b6',
  api: '#3ecf8e',
  logic: '#8b9cff',
  data: '#f5a524',
  jobs: '#5ec8e5',
  shared: '#c084fc',
  infra: '#94a3b8',
};
const KIND_ICON: Record<string, string> = {
  page: 'canvas',
  component: 'grid',
  endpoint: 'branch',
  service: 'spark',
  model: 'db',
  job: 'refresh',
  config: 'settings',
  module: 'code',
};
const OP_WORD: Record<TableOp, string> = { read: 'reads', create: 'adds to', update: 'changes', delete: 'removes from' };
const ITEM_W = 260;
const ITEM_H = 58;
const GAP = 12;
const LANE_PAD = 16;
const LANE_HEAD = 84;
const LANE_GAP = 90;
const FIELD_H = 21;
const FIELDS_SHUT = 5;
const PART_H = 46;

// ---- shared by the cards ----
interface Ctx {
  expanded: Set<string>;
  zooming: Set<string>;
  zoom: (id: string) => MapZoom | undefined;
  toggle: (id: string) => void;
  open: (path: string, line?: number) => void;
  select: (id: string) => void;
  nameOf: (id: string) => string;
}
const MapCtx = createContext<Ctx>(null as any);

const isModel = (it: Item) => !!it.fields?.length;
function heightOf(it: Item, ctx: Pick<Ctx, 'expanded' | 'zoom'>) {
  const open = ctx.expanded.has(it.id);
  if (isModel(it)) {
    const n = open ? it.fields!.length : Math.min(FIELDS_SHUT, it.fields!.length);
    return ITEM_H + 6 + n * FIELD_H + (it.fields!.length > n ? FIELD_H : 0) + 6;
  }
  if (!open) return ITEM_H;
  const z = ctx.zoom(it.id);
  if (!z) return ITEM_H + 46;
  return ITEM_H + 8 + (z.files.length > 1 ? 30 : 0) + Math.max(1, z.parts.length) * PART_H + 6;
}

type ItemData = { item: Item; color: string; state: 'focus' | 'near' | 'dim' | ''; order?: string; touch?: TableOp; h: number };
type LaneData = { layer: Layer; color: string; count: number; height: number };

const ItemNode = memo(function ItemNode({ data }: NodeProps<Node<ItemData>>) {
  const { item, color, state, order, touch, h } = data;
  const ctx = useContext(MapCtx);
  const open = ctx.expanded.has(item.id);
  const z = ctx.zoom(item.id);
  const loading = ctx.zooming.has(item.id);
  const fields = item.fields ?? [];
  const shown = open ? fields : fields.slice(0, FIELDS_SHUT);
  return (
    <div className={`map-item ${state} ${open ? 'open' : ''} ${fields.length ? 'model' : ''} ${touch ? `touch ${touch}` : ''}`} style={{ ['--lane' as any]: color, height: h }}>
      <Handle type="target" position={Position.Left} className="mi-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="mi-handle" isConnectable={false} />
      <div className="mi-head">
        <span className="mi-icon">
          <Icon name={(KIND_ICON[item.kind] ?? 'code') as any} size={13} />
        </span>
        <span className="mi-text">
          <b className="ellipsis">{item.name}</b>
          <span className="ellipsis">{item.route ?? item.path}</span>
        </span>
        {order ? <span className="mi-order">{order}</span> : null}
        {(!fields.length || fields.length > FIELDS_SHUT) && (
          <button
            className="mi-open nodrag nopan"
            title={open ? 'Close' : fields.length ? 'Show every field' : 'Open up: files and functions inside'}
            aria-label={open ? 'Close' : 'Open up'}
            onClick={(e) => {
              e.stopPropagation();
              ctx.toggle(item.id);
            }}
          >
            {loading ? <span className="spinner" /> : <Icon name="chevronDown" size={14} />}
          </button>
        )}
      </div>
      {touch && <span className="mi-touch">{OP_WORD[touch]}</span>}
      {fields.length > 0 && (
        <div className="mi-fields">
          {shown.map((f) => (
            <div key={f.name} className="mi-field" title={f.note}>
              <span className="ellipsis">{f.name}</span>
              <em className="ellipsis">{f.type}</em>
            </div>
          ))}
          {fields.length > shown.length && <div className="mi-field more">+{fields.length - shown.length} more</div>}
        </div>
      )}
      {open && !fields.length && (
        <div className="mi-inside nodrag nopan">
          {!z ? (
            <div className="mi-loading">
              <span className="spinner" /> Reading {item.path.split('/').pop()}…
            </div>
          ) : (
            <>
              {z.files.length > 1 && (
                <div className="mi-files">
                  {z.files.map((f) => (
                    <button key={f.path} title={`${f.path}\n${f.summary}`} onClick={(e) => (e.stopPropagation(), ctx.open(f.path))}>
                      <Icon name="file" size={11} /> {f.path.split('/').pop()}
                    </button>
                  ))}
                </div>
              )}
              {z.parts.map((p, i) => (
                <div key={i} className="mi-part" onClick={(e) => (e.stopPropagation(), ctx.open(p.path, p.line))} title={`${p.path}${p.line ? `:${p.line}` : ''}`}>
                  <div className="mi-part-top">
                    <code className="ellipsis">{p.name}</code>
                    {(p.uses ?? []).slice(0, 2).map((u) => (
                      <button key={u} className="mi-uses" onClick={(e) => (e.stopPropagation(), ctx.select(u))}>
                        → {ctx.nameOf(u)}
                      </button>
                    ))}
                  </div>
                  <span className="ellipsis">{p.summary}</span>
                </div>
              ))}
              {!z.parts.length && <div className="mi-loading">Nothing inside worth listing.</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
});
const LaneNode = memo(function LaneNode({ data }: NodeProps<Node<LaneData>>) {
  return (
    <div className="map-lane" style={{ ['--lane' as any]: data.color, height: data.height }}>
      <div className="ml-head">
        <b>{data.layer.name}</b>
        <span>{data.layer.summary}</span>
      </div>
    </div>
  );
});
const nodeTypes = { item: ItemNode, lane: LaneNode };

function layout(map: CodeMap, ctx: Pick<Ctx, 'expanded' | 'zoom'>) {
  const lanes = [...map.layers].sort((a, b) => LANE_ORDER.indexOf(a.kind) - LANE_ORDER.indexOf(b.kind));
  const pos = new Map<string, { x: number; y: number; h: number }>();
  const laneNodes: Node<LaneData>[] = [];
  lanes.forEach((l, i) => {
    const items = map.items.filter((it) => it.layer === l.id);
    const x = i * (ITEM_W + LANE_PAD * 2 + LANE_GAP);
    let y = LANE_HEAD;
    for (const it of items) {
      const h = heightOf(it, ctx);
      pos.set(it.id, { x: x + LANE_PAD, y, h });
      y += h + GAP;
    }
    const height = y + LANE_PAD - GAP;
    laneNodes.push({ id: `lane-${l.id}`, type: 'lane', position: { x, y: 0 }, data: { layer: l, color: LANE_COLOR[l.kind] ?? '#94a3b8', count: items.length, height }, draggable: false, selectable: false, zIndex: -1, style: { width: ITEM_W + LANE_PAD * 2 } });
  });
  return { lanes, laneNodes, pos };
}

// ---- matching a table name in a step to a model on the map ----
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\b(model|table|collection|schema)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/(ies)$/, 'y')
    .replace(/s$/, '');
function tableItems(map: CodeMap, step: MapTraceStep | undefined) {
  const out = new Map<string, TableOp>();
  if (!step?.tables?.length) return out;
  const models = map.items.filter((i) => isModel(i) || i.kind === 'model');
  for (const t of step.tables) {
    const n = norm(t.name);
    const m = models.find((i) => norm(i.name) === n) ?? models.find((i) => n && (norm(i.name).includes(n) || n.includes(norm(i.name))));
    if (m && !(out.get(m.id) && t.op === 'read')) out.set(m.id, t.op);
  }
  return out;
}

interface Walk {
  trace: MapTrace;
  step: number;
}

function MapCanvas({ map, sel, setSel, answer, walk, search, ctx }: { map: CodeMap; sel: string | null; setSel: (id: string | null) => void; answer: MapAnswer | null; walk: Walk | null; search: string; ctx: Ctx }) {
  const rf = useReactFlow();
  const theme = useResolvedTheme();
  const zoomSig = Object.keys(map.zoom ?? {}).join();
  const { lanes, laneNodes, pos } = useMemo(() => layout(map, ctx), [map, [...ctx.expanded].join(), zoomSig]);
  const laneColor = useMemo(() => new Map(lanes.map((l) => [l.id, LANE_COLOR[l.kind] ?? '#94a3b8'])), [lanes]);
  const needle = search.trim().toLowerCase();
  const focus = walk ? [] : (answer?.focus ?? []);
  const near = useMemo(() => {
    const s = new Set<string>();
    if (sel) for (const l of map.links) if (l.from === sel || l.to === sel) s.add(l.from === sel ? l.to : l.from);
    return s;
  }, [sel, map]);

  // The walkthrough: which card each step is on, and the tables the current step touches.
  const steps = walk?.trace.steps ?? [];
  const cur = walk && walk.step >= 0 ? steps[walk.step] : undefined;
  const touched = useMemo(() => (walk ? tableItems(map, cur) : new Map<string, TableOp>()), [walk?.step, walk?.trace, map]);
  const visits = useMemo(() => {
    const v = new Map<string, number[]>();
    steps.forEach((s, i) => s.item && v.set(s.item, [...(v.get(s.item) ?? []), i + 1]));
    return v;
  }, [walk?.trace]);

  const nodes: Node[] = useMemo(() => {
    const items: Node<ItemData>[] = map.items.map((it) => {
      let state: ItemData['state'] = '';
      let order: string | undefined;
      if (walk) {
        const seen = visits.get(it.id);
        state = cur?.item === it.id ? 'focus' : touched.has(it.id) ? 'near' : seen ? 'near' : 'dim';
        if (seen) order = seen.length > 2 ? `${seen[0]}–${seen.at(-1)}` : seen.join('·');
      } else {
        const hit = needle ? `${it.name} ${it.path} ${it.route ?? ''} ${it.summary}`.toLowerCase().includes(needle) : true;
        const inFocus = focus.includes(it.id);
        state = it.id === sel || inFocus ? 'focus' : near.has(it.id) ? 'near' : (sel || focus.length || needle) && !(needle && hit) ? 'dim' : needle && hit ? 'near' : '';
        if (inFocus && focus.length > 1) order = String(focus.indexOf(it.id) + 1);
      }
      const p = pos.get(it.id) ?? { x: 0, y: 0, h: ITEM_H };
      return {
        id: it.id,
        type: 'item',
        position: { x: p.x, y: p.y },
        data: { item: it, color: laneColor.get(it.layer) ?? '#94a3b8', state, order, touch: touched.get(it.id), h: p.h },
        draggable: false,
        width: ITEM_W,
        height: p.h,
        zIndex: state === 'focus' ? 3 : 1,
      };
    });
    return [...laneNodes, ...items];
  }, [map, pos, laneNodes, laneColor, sel, focus.join(), near, needle, walk?.step, walk?.trace, touched, visits]);

  const edges: Edge[] = useMemo(() => {
    if (walk) {
      // The path the data takes: lit up to where you are, faint after.
      const out: Edge[] = [];
      let prev: { item: string; i: number } | null = null;
      steps.forEach((s, i) => {
        if (!s.item) return;
        if (prev && prev.item !== s.item)
          out.push({ id: `t${i}`, source: prev.item, target: s.item, className: `map-edge trace ${i === walk.step ? 'now' : i < walk.step ? 'past' : 'ahead'}`, zIndex: 6 });
        prev = { item: s.item, i };
      });
      if (cur?.item) for (const [id] of touched) if (id !== cur.item) out.push({ id: `db${id}`, source: cur.item, target: id, className: 'map-edge touch now', zIndex: 6 });
      return out;
    }
    // A piece you clicked: its own lines. An answer: only the lines between the parts it names.
    const f = new Set(focus);
    const isOn = (l: CodeMap['links'][number]) => (sel ? l.from === sel || l.to === sel : f.size > 0 && f.has(l.from) && f.has(l.to));
    const any = !!sel || f.size > 0;
    return map.links.map((l, i) => {
      const on = isOn(l);
      return { id: `e${i}`, source: l.from, target: l.to, label: on ? l.label : undefined, className: on ? 'map-edge on' : any ? 'map-edge off' : 'map-edge', zIndex: on ? 5 : 0 };
    });
  }, [map, sel, focus.join(), walk?.step, walk?.trace, touched]);

  // Frame some cards in the part of the map you can see: left of the side panel, above the ask box.
  const frame = (ids: string[], maxZoom: number, minZoom = 0.3): void => {
    const boxes = ids.map((id) => pos.get(id)).filter(Boolean) as { x: number; y: number; h: number }[];
    const stage = document.querySelector('.map-stage')?.getBoundingClientRect();
    if (!boxes.length || !stage) return;
    const side = document.querySelector('.map-side')?.getBoundingClientRect();
    const right = side ? side.left - stage.left - 24 : stage.width - 24;
    const left = 24;
    const top = 24;
    const bottom = stage.height - 130;
    const x0 = Math.min(...boxes.map((b) => b.x)) - 30;
    const y0 = Math.min(...boxes.map((b) => b.y)) - 30;
    const x1 = Math.max(...boxes.map((b) => b.x + ITEM_W)) + 30;
    const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + 30;
    const fit = Math.min(maxZoom, (right - left) / (x1 - x0), (bottom - top) / (y1 - y0));
    // Too far apart to read together: keep the first one (the step you're on) in view.
    if (fit < minZoom && ids.length > 1) return frame(ids.slice(0, 1), maxZoom, minZoom);
    const zoom = Math.max(minZoom, fit);
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    rf.setViewport({ x: cx - ((x0 + x1) / 2) * zoom, y: cy - ((y0 + y1) / 2) * zoom, zoom }, { duration: 650 });
  };
  // An answer arrives: bring the parts it's about into view.
  useEffect(() => {
    if (!focus.length) return;
    const t = setTimeout(() => frame(focus, 1.05), 80);
    return () => clearTimeout(t);
  }, [answer?.at, !!walk]);
  // Each step of a walkthrough: follow the data.
  useEffect(() => {
    if (!walk) return;
    // The step's card plus the table it changes (or reads), so both stay readable.
    const tables = [...touched.entries()].sort((a, b) => (a[1] === 'read' ? 1 : 0) - (b[1] === 'read' ? 1 : 0)).map(([id]) => id);
    const ids = (walk.step < 0 ? [...visits.keys()] : [cur?.item, tables[0]]).filter(Boolean) as string[];
    if (!ids.length) return;
    const t = setTimeout(() => frame(ids, walk.step < 0 ? 0.8 : 1, walk.step < 0 ? 0.3 : 0.6), 60);
    return () => clearTimeout(t);
  }, [walk?.step, walk?.trace]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={theme}
      onNodeClick={(_, n) => n.type === 'item' && setSel(n.id === sel ? null : n.id)}
      onNodeDoubleClick={(_, n) => n.type === 'item' && ctx.toggle(n.id)}
      onPaneClick={() => setSel(null)}
      zoomOnDoubleClick={false}
      fitView
      fitViewOptions={{ padding: 0.12 }}
      minZoom={0.15}
      maxZoom={1.6}
      panOnScroll
      nodesConnectable={false}
      nodesDraggable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}

// ---- sample data, with what changed since the last step ----
const parse = (s?: string) => {
  if (!s) return undefined;
  try {
    return { ok: true as const, v: JSON.parse(s) };
  } catch {
    return { ok: false as const, v: s };
  }
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const scalar = (v: unknown) => (typeof v === 'string' ? `"${v}"` : v === null ? 'null' : String(v));

function JsonTree({ v, prev, depth = 0 }: { v: unknown; prev: unknown; depth?: number }): ReactNode {
  if (!isObj(v)) return <span className={`jv-v ${typeof v}`}>{scalar(v)}</span>;
  const arr = Array.isArray(v);
  const keys = arr ? v.map((_, i) => String(i)) : Object.keys(v);
  const shown = arr ? keys.slice(0, 5) : keys;
  const pv = isObj(prev) && Array.isArray(prev) === arr ? (prev as Record<string, unknown>) : undefined;
  const gone = pv && !arr ? Object.keys(pv).filter((k) => !(k in v)) : [];
  if (!keys.length && !gone.length) return <span className="jv-v">{arr ? '[]' : '{}'}</span>;
  return (
    <span className="jv-block">
      {arr ? '[' : '{'}
      {shown.map((k) => {
        const val = (v as any)[k];
        const had = pv ? k in pv : true;
        const st = !pv ? '' : !had ? 'add' : !isObj(val) && !same(val, pv[k]) ? 'chg' : '';
        return (
          <span key={k} className={`jv-row ${st}`} style={{ paddingLeft: 14 }}>
            {!arr && <span className="jv-k">{k}: </span>}
            <JsonTree v={val} prev={had && pv ? pv[k] : !pv ? undefined : null} depth={depth + 1} />
          </span>
        );
      })}
      {arr && keys.length > 5 && <span className="jv-row faint" style={{ paddingLeft: 14 }}>…{keys.length - 5} more</span>}
      {gone.map((k) => (
        <span key={`-${k}`} className="jv-row del" style={{ paddingLeft: 14 }}>
          <span className="jv-k">{k}: </span>
          {isObj(pv![k]) ? '…' : scalar(pv![k])}
        </span>
      ))}
      {arr ? ']' : '}'}
    </span>
  );
}

/** What changed between two samples, in words, for steps that didn't say. */
function changesInWords(prev?: string, next?: string): string[] {
  const a = parse(prev);
  const b = parse(next);
  if (!b?.ok) return [];
  const flat = (v: unknown, pre = '', out = new Map<string, unknown>(), depth = 0) => {
    if (isObj(v) && depth < 3 && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) flat(x, pre ? `${pre}.${k}` : k, out, depth + 1);
    else out.set(pre, v);
    return out;
  };
  const short = (v: unknown) => {
    const t = Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : isObj(v) ? 'set' : scalar(v);
    return t.length > 40 ? `${t.slice(0, 38)}…` : t;
  };
  const before = a?.ok ? flat(a.v) : new Map();
  const after = flat(b.v);
  const out: string[] = [];
  for (const [k, v] of after) {
    if (/(^|\.)_/.test(k)) continue;
    if (!before.has(k)) out.push(`New: ${k} is ${short(v)}`);
    else if (!same(before.get(k), v)) out.push(`${k} went from ${short(before.get(k))} to ${short(v)}`);
  }
  return out.slice(0, 4);
}

function DataCard({ text, prev, label }: { text: string; prev?: string; label: string }) {
  const cur = parse(text)!;
  const before = parse(prev);
  return (
    <div className="tr-data">
      <div className="tr-data-head">
        <span>{label}</span>
        {before?.ok && cur.ok && (
          <span className="tr-legend">
            <i className="add" /> new <i className="chg" /> changed
          </span>
        )}
      </div>
      {cur.ok ? (
        <div className="jv">
          <JsonTree v={cur.v} prev={before?.ok ? before.v : undefined} />
        </div>
      ) : (
        <pre className="jv">{text}</pre>
      )}
    </div>
  );
}

const CHECK_WORD: Record<string, string> = { stop: 'Stops', skip: 'Skips', continue: 'Goes another way', retry: 'Tries again', other: 'Then' };
/** "stops: too many items" → "too many items" (the label already says it stops). */
const plainThen = (t: string) => {
  const v = t.replace(/^(it\s+)?(stops|skips|tries again|retries|then)\b[:,]?\s*/i, '').trim();
  return v ? v[0].toUpperCase() + v.slice(1) : t;
};
const stepTitle = (s: MapTraceStep, i: number) => s.title || s.fn || `Step ${i + 1}`;
const seeData = () => {
  try {
    return localStorage.getItem('forkspace:map-data') === '1';
  } catch {
    return false;
  }
};

function Walkthrough({ trace, step, setStep, open, nameOf, playing, setPlaying }: { trace: MapTrace; step: number; setStep: (n: number) => void; open: (p: string, l?: number) => void; nameOf: (id: string) => string; playing: boolean; setPlaying: (b: boolean) => void }) {
  const list = useRef<HTMLOListElement>(null);
  const [showData, setShowData] = useState(seeData);
  const n = trace.steps.length;
  useEffect(() => {
    list.current?.querySelector('.tr-step.on')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [step]);
  const toggleData = () =>
    setShowData((v) => {
      try {
        localStorage.setItem('forkspace:map-data', v ? '0' : '1');
      } catch {}
      return !v;
    });
  // The data as it was before a step: the last step that had some, or what came in.
  const before = (i: number) => {
    for (let j = i - 1; j >= 0; j--) if (trace.steps[j].data) return trace.steps[j].data;
    return trace.input;
  };
  // The journey in a few parts ("Before payment", "Payment"...), in order.
  const stages = useMemo(() => {
    const out: { name: string; first: number; last: number }[] = [];
    trace.steps.forEach((s, i) => {
      const name = s.stage?.trim();
      if (!name) return;
      const last = out.at(-1);
      if (last && last.name === name) last.last = i;
      else out.push({ name, first: i, last: i });
    });
    return out.length > 1 ? out : [];
  }, [trace]);
  const cur = step >= 0 ? trace.steps[step] : undefined;

  return (
    <div className="trace">
      <div className="tr-bar">
        <b className="tr-title">{trace.title}</b>
        {stages.length > 0 && (
          <div className="tr-stages">
            {stages.map((g) => {
              const st = step > g.last ? 'past' : step >= g.first ? 'on' : '';
              const fill = st === 'past' ? 1 : st === 'on' ? (step - g.first + 1) / (g.last - g.first + 1) : 0;
              return (
                <button key={g.first} className={`tr-stage ${st}`} style={{ flex: 1 }} onClick={() => setStep(g.first)} title={`Jump to: ${g.name}`}>
                  <i>
                    <u style={{ width: `${fill * 100}%` }} />
                  </i>
                  <span className="ellipsis">{g.name}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="tr-controls">
          <button className="icon-btn sm" onClick={() => setStep(Math.max(-1, step - 1))} disabled={step <= -1} aria-label="Back" title="Back (←)">
            <Icon name="chevronLeft" size={15} />
          </button>
          <button className="tr-play" onClick={() => (step >= n - 1 ? (setStep(-1), setPlaying(true)) : setPlaying(!playing))} title="Play (Space)">
            <Icon name={playing ? 'pause' : 'play'} size={13} /> {playing ? 'Pause' : step >= n - 1 ? 'Replay' : step < 0 ? 'Play' : 'Play on'}
          </button>
          <button className="icon-btn sm" onClick={() => setStep(Math.min(n - 1, step + 1))} disabled={step >= n - 1} aria-label="Next" title="Next (→)">
            <Icon name="chevronRight" size={15} />
          </button>
          <span className="faint small">{step < 0 ? 'Start' : `Step ${step + 1} of ${n}`}</span>
        </div>
        {!stages.length && (
          <div className="tr-progress">
            <i style={{ width: `${((step + 1) / n) * 100}%` }} />
          </div>
        )}
      </div>
      <ol className="tr-steps" ref={list}>
        {trace.input && (
          <li className={`tr-step start ${step === -1 ? 'on' : 'past'}`} onClick={() => setStep(-1)}>
            <span className="tr-num">
              <Icon name="play" size={10} />
            </span>
            <div className="tr-body">
              <b className="tr-step-title">What comes in</b>
              {step === -1 && (
                <>
                  <p>This is a made-up example in the real shape. Press play or → to follow it.</p>
                  <DataCard text={trace.input} label="The example" />
                </>
              )}
            </div>
          </li>
        )}
        {trace.steps.map((s, i) => {
          const stageHere = stages.find((g) => g.first === i);
          const on = i === step;
          const checks = s.checks ?? [];
          const changes = on ? (s.changes?.length ? s.changes : changesInWords(before(i), s.data)) : [];
          return (
            <li key={i} className={`tr-step ${on ? 'on' : i < step ? 'past' : ''} ${stageHere ? 'stage-start' : ''}`} data-stage={stageHere?.name} onClick={() => !on && setStep(i)}>
              <span className="tr-num">{i < step ? <Icon name="check" size={11} strokeWidth={2.6} /> : i + 1}</span>
              <div className="tr-body">
                <div className="tr-head">
                  <b className="tr-step-title">{stepTitle(s, i)}</b>
                  {!on && checks.length > 0 && (
                    <span className="tr-badge" title={`${checks.length} decision${checks.length === 1 ? '' : 's'} here`}>
                      <Icon name="branch" size={10} /> {checks.length}
                    </span>
                  )}
                </div>
                {on && (
                  <div className="tr-open">
                    <p className="tr-does">{s.does}</p>
                    {checks.length > 0 && (
                      <div className="tr-checks">
                        <div className="tr-label">
                          <Icon name="branch" size={11} /> {checks.length === 1 ? 'One decision here' : `${checks.length} decisions here`}
                        </div>
                        {checks.map((c, k) => (
                          <div key={k} className={`tr-check ${c.kind}`}>
                            <div className="tr-if">
                              <span>If</span> {c.if.replace(/^if\s+/i, '')}
                            </div>
                            <div className="tr-then">
                              <em>{CHECK_WORD[c.kind] ?? 'Then'}</em> {plainThen(c.then)}
                            </div>
                          </div>
                        ))}
                        <div className="tr-check otherwise">
                          <div className="tr-then">
                            <em>Otherwise</em> it carries on to {trace.steps[i + 1] ? <b>{stepTitle(trace.steps[i + 1], i + 1)}</b> : 'the end'}.
                          </div>
                        </div>
                      </div>
                    )}
                    {(changes.length > 0 || !!s.tables?.length) && (
                      <div className="tr-changes">
                        <div className="tr-label">What changed</div>
                        {changes.map((c, k) => (
                          <div key={k} className="tr-change">
                            {c}
                          </div>
                        ))}
                        {!!s.tables?.length && (
                          <div className="tr-tables">
                            {s.tables.map((t, k) => (
                              <span key={k} className={`tr-table ${t.op}`}>
                                <Icon name="db" size={11} /> {OP_WORD[t.op] ?? t.op} <b>{t.name}</b>
                                {t.what && <em>{t.what}</em>}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {s.data && (
                      <>
                        <button className="tr-toggle" onClick={toggleData}>
                          <Icon name={showData ? 'chevronDown' : 'chevronRight'} size={12} /> {showData ? 'Hide the data' : 'See the data at this point'}
                        </button>
                        {showData && <DataCard text={s.data} prev={before(i)} label="The data now" />}
                      </>
                    )}
                    <div className="tr-code">
                      <span className="faint">In the code:</span>
                      <button className="tr-file" onClick={() => open(s.path, s.line)} title="Open in the Code view">
                        {s.fn && <code>{s.fn}</code>}
                        <span>
                          {s.path.split('/').pop()}
                          {s.line ? `:${s.line}` : ''}
                        </span>
                      </button>
                      {s.item && <span className="faint">· {nameOf(s.item)}</span>}
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
        {cur && step === n - 1 && (
          <li className="tr-end">
            <Icon name="check" size={13} /> That's the whole journey.{' '}
            <button className="linkish" onClick={() => (setStep(-1), setPlaying(true))}>
              Play it again
            </button>
          </li>
        )}
      </ol>
    </div>
  );
}

/** The prompt for an agent to check a walkthrough against the real code. */
function checkPrompt(a: MapAnswer) {
  const t = a.trace!;
  const steps = t.steps
    .map((s, i) => {
      const checks = (s.checks ?? []).map((c) => `   - If ${c.if}: ${c.then}`).join('\n');
      return `${i + 1}. ${s.title ?? s.fn ?? 'Step'} (${s.fn ? `${s.fn}, ` : ''}${s.path}${s.line ? `:${s.line}` : ''})\n   ${s.does}${checks ? `\n${checks}` : ''}`;
    })
    .join('\n');
  return [
    `Check this walkthrough against the real code by running it: "${a.question}"`,
    ``,
    `## The walkthrough: ${t.title}`,
    t.input ? `Sample input:\n\`\`\`json\n${t.input}\n\`\`\`` : '',
    steps,
    ``,
    `## What to do`,
    `1. Find how this project runs tests (package.json scripts, the test folder, existing tests for this area) and follow the same setup.`,
    `2. Write automated tests that send the sample through the real code and check the outcome of each step. Give every "If" its own test case where it's practical.`,
    `3. Run them and fix only the tests, never the app code.`,
    ``,
    `## Safety`,
    `- Never touch real databases, payment providers, email or any live service. Use the test setup's test or in-memory database and mocks.`,
    `- Don't use secrets from .env for live services.`,
    `- If there is no safe way to run this, stop and say what's missing instead.`,
    ``,
    `## Finish with`,
    `- One line verdict: does the code do what the walkthrough says?`,
    `- A table: step or decision | matches? (yes / no / not tested) | test name.`,
    `- Anything the walkthrough got wrong, and any bug you found, in plain words.`,
    `- Where the test file is and the command to run it again.`,
  ]
    .filter((x) => x !== '')
    .join('\n');
}

function lastWords(t: TurnNode) {
  for (let i = t.events.length - 1; i >= 0; i--) {
    const e = t.events[i];
    if (e.t === 'text' && e.text.trim()) return e.text;
  }
  return '';
}

function CheckCard({ a, board, onStart, onOpen }: { a: MapAnswer; board: Board; onStart: () => void; onOpen: (id: string) => void }) {
  const { nodes } = useStore();
  const turn = a.check ? (nodes[a.check.nodeId] as TurnNode | undefined) : undefined;
  const [more, setMore] = useState(false);
  if (!turn)
    return (
      <div className="check-card">
        <div className="check-head">
          <Icon name="flask" size={15} />
          <b>Check it for real</b>
        </div>
        <p>
          An agent writes tests that send this example through the real code and checks every step and decision. It works {board.isolation === 'worktree' ? 'in its own copy of the code' : 'in your project folder'} and never touches live data or payments.
        </p>
        <button className="btn sm primary" onClick={onStart}>
          <Icon name="play" size={12} /> Run the check
        </button>
      </div>
    );
  const live = isLive(turn);
  const words = lastWords(turn);
  return (
    <div className={`check-card ${live ? 'live' : turn.status}`}>
      <div className="check-head">
        {live ? <span className="spinner" /> : <Icon name={turn.status === 'done' ? 'check' : 'x'} size={14} />}
        <b>{live ? (turn.status === 'waiting' ? 'The check needs your OK' : 'Checking against the real code…') : turn.status === 'done' ? 'Checked against the real code' : 'The check did not finish'}</b>
        <span className="spacer" />
        <button className="linkish small" onClick={() => onOpen(turn.id)}>
          Open the thread
        </button>
      </div>
      {live ? (
        <p className="faint ellipsis">{currentActivity(turn)}</p>
      ) : words ? (
        <div className={`check-words ${more ? 'all' : ''}`}>
          <Md text={words} />
          {!more && <button className="check-more" onClick={() => setMore(true)}>Show all</button>}
        </div>
      ) : null}
      {!live && (
        <button className="btn sm" onClick={onStart}>
          <Icon name="refresh" size={12} /> Check again
        </button>
      )}
    </div>
  );
}

function SaveBar({ a, onSave }: { a: MapAnswer; onSave: (name: string | null) => void }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  if (a.saved)
    return (
      <button className="save-btn on" onClick={() => onSave(null)} title="Saved. Click to remove from saved flows">
        <Icon name="bookmark" size={13} fill="currentColor" /> {a.saved.name}
      </button>
    );
  if (naming)
    return (
      <form
        className="save-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim());
          setNaming(false);
        }}
      >
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this flow" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setNaming(false))} />
        <button className="btn sm primary" type="submit" disabled={!name.trim()}>
          Save
        </button>
      </form>
    );
  return (
    <button
      className="save-btn"
      onClick={() => {
        setName(a.trace?.title.replace(/^(A|An|The)\s+/, '').slice(0, 60) ?? a.question.slice(0, 60));
        setNaming(true);
      }}
      title="Keep this flow to come back to"
    >
      <Icon name="bookmark" size={13} /> Save flow
    </button>
  );
}

export function MapView({ board, onOpenFile, onStartThread, onOpenThread }: { board: Board; onOpenFile: (path: string, line?: number) => void; onStartThread: (prompt: string) => Promise<string | null>; onOpenThread: (id: string) => void }) {
  useTick();
  const [map, setMap] = useState<CodeMap | null>(null);
  const [stale, setStale] = useState(false);
  const [head, setHead] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [asking, setAsking] = useState(false);
  const [answers, setAnswers] = useState<MapAnswer[]>([]);
  const [shown, setShown] = useState<MapAnswer | null>(null);
  const [step, setStep] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [zooming, setZooming] = useState<Set<string>>(new Set());
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setLoading(true);
    setMap(null);
    setSel(null);
    setAnswers([]);
    setShown(null);
    setExpanded(new Set());
    request<{ map: CodeMap | null; stale: boolean; answers?: MapAnswer[]; head?: string }>({ type: 'mapGet', boardId: board.id }).then(
      (r) => {
        setMap(r.map);
        setHead(r.head);
        setStale(r.stale);
        setAnswers(r.answers ?? []);
        setLoading(false);
      },
      () => setLoading(false),
    );
  }, [board.id]);
  useEffect(() => onMapProgress((m) => m.boardId === board.id && setProgress((p) => [...p.slice(-5), m.text])), [board.id]);

  const show = (a: MapAnswer | null) => {
    setShown(a);
    setStep(-1);
    setPlaying(!!a?.trace);
    setSel(null);
  };
  const walk: Walk | null = shown?.trace && !sel ? { trace: shown.trace, step } : null;

  // Play: one step every few seconds, longer when there's data to look at.
  useEffect(() => {
    if (!playing || !shown?.trace) return;
    const n = shown.trace.steps.length;
    if (step >= n - 1) return setPlaying(false);
    // Time to read: longer when the step has more to say or decisions to take in.
    const here = shown.trace.steps[step];
    const words = here ? `${here.does} ${(here.checks ?? []).map((c) => `${c.if} ${c.then}`).join(' ')} ${(here.changes ?? []).join(' ')}`.split(/\s+/).length : 25;
    const t = setTimeout(() => setStep(step + 1), Math.min(14000, Math.max(3000, words * 230)));
    return () => clearTimeout(t);
  }, [playing, step, shown]);
  // Arrow keys walk the steps; Space plays.
  useEffect(() => {
    if (!walk) return;
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, [contenteditable]')) return;
      const n = shown!.trace!.steps.length;
      if (e.key === 'ArrowRight') (e.preventDefault(), setPlaying(false), setStep((s) => Math.min(n - 1, s + 1)));
      else if (e.key === 'ArrowLeft') (e.preventDefault(), setPlaying(false), setStep((s) => Math.max(-1, s - 1)));
      else if (e.key === ' ') (e.preventDefault(), setPlaying((p) => !p));
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [!!walk, shown]);

  const build = async () => {
    setBuilding(true);
    setProgress([]);
    try {
      const r = await request<{ map: CodeMap; stale: boolean }>({ type: 'mapBuild', boardId: board.id });
      setMap(r.map);
      setStale(false);
      setSel(null);
      setExpanded(new Set());
      show(null);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setBuilding(false);
  };

  const ask = async (question = q, replace?: MapAnswer) => {
    const text = question.trim();
    if (!text || asking) return;
    const had = !replace && answers.find((a) => a.question.toLowerCase() === text.toLowerCase());
    if (had) return show(had), setQ('');
    setAsking(true);
    setProgress([]);
    setSel(null);
    try {
      const a = await request<MapAnswer>({ type: 'mapAsk', boardId: board.id, question: text, replace: replace?.at });
      setAnswers((l) => [a, ...l.filter((x) => x.at !== replace?.at)]);
      if (a.commit) setHead(a.commit);
      show(a);
      setQ('');
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setAsking(false);
  };
  const patch = (a: MapAnswer) => {
    setAnswers((l) => l.map((x) => (x.at === a.at ? a : x)));
    setShown((s) => (s?.at === a.at ? a : s));
  };
  const saveFlow = (a: MapAnswer, name: string | null) =>
    request<MapAnswer>({ type: 'mapSave', boardId: board.id, at: a.at, name }).then(
      (r) => (patch(r), toast(name ? 'Saved. It stays at the top of the map' : 'Removed from saved flows')),
      (e: Error) => toast(e.message, 'error'),
    );
  const runCheck = async (a: MapAnswer) => {
    const id = await onStartThread(checkPrompt(a));
    if (!id) return;
    request<MapAnswer>({ type: 'mapCheck', boardId: board.id, at: a.at, nodeId: id }).then(patch, () => {});
    toast('Check started. It runs as a thread on the canvas');
  };
  const savedFlows = answers.filter((a) => a.saved);
  const forget = (a: MapAnswer) => {
    setAnswers((l) => l.filter((x) => x.at !== a.at));
    if (shown?.at === a.at) show(null);
    request({ type: 'mapForget', boardId: board.id, at: a.at }).catch(() => {});
  };

  const nameOf = (id: string) => map?.items.find((i) => i.id === id)?.name ?? id;
  const toggle = (id: string) => {
    const it = map?.items.find((i) => i.id === id);
    if (!it) return;
    const open = !expanded.has(id);
    setExpanded((s) => {
      const n = new Set(s);
      open ? n.add(id) : n.delete(id);
      return n;
    });
    if (!open || isModel(it) || map?.zoom?.[id] || zooming.has(id)) return;
    setZooming((s) => new Set(s).add(id));
    request<MapZoom>({ type: 'mapZoom', boardId: board.id, itemId: id })
      .then(
        (z) => setMap((m) => (m ? { ...m, items: z.fields?.length ? m.items.map((i) => (i.id === id && !i.fields?.length ? { ...i, fields: z.fields } : i)) : m.items, zoom: { ...m.zoom, [id]: z } } : m)),
        (e: Error) => {
          toast(e.message, 'error');
          setExpanded((s) => {
            const n = new Set(s);
            n.delete(id);
            return n;
          });
        },
      )
      .finally(() =>
        setZooming((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        }),
      );
  };
  const ctx: Ctx = { expanded, zooming, zoom: (id) => map?.zoom?.[id], toggle, open: onOpenFile, select: setSel, nameOf };

  const item = sel && map ? map.items.find((i) => i.id === sel) : undefined;
  const links = item && map ? map.links.filter((l) => l.from === item.id || l.to === item.id) : [];
  const zoom = item ? map?.zoom?.[item.id] : undefined;
  const flows = map?.flows?.length ? map.flows : [{ name: 'A request', question: 'How does a request flow from a page to the database?' }, { name: 'Login', question: 'What happens when someone logs in?' }];

  if (loading)
    return (
      <div className="map-empty">
        <span className="spinner" />
      </div>
    );
  if (!map)
    return (
      <div className="map-empty">
        <div className="map-hero">
          <div className="map-hero-art" aria-hidden>
            {['#f472b6', '#3ecf8e', '#8b9cff', '#f5a524'].map((c, i) => (
              <span key={c} style={{ ['--lane' as any]: c, animationDelay: `${i * 120}ms` }}>
                <i />
                <i />
                <i />
              </span>
            ))}
          </div>
          <h2>See how {board.name} fits together</h2>
          <p>Claude reads the project (it never changes anything) and draws a map: the screens, the API routes, the logic and the data behind them, and what calls what. Then ask how anything works and watch it play out.</p>
          {building ? (
            <div className="map-progress">
              <span className="spinner" />
              <span>{progress.at(-1) ?? 'Starting'}…</span>
            </div>
          ) : (
            <button className="btn primary" onClick={build}>
              <Icon name="spark" size={14} /> Draw the map
            </button>
          )}
          <p className="faint small">Takes a minute or two on a big project. Uses your Claude Code login.</p>
        </div>
      </div>
    );

  return (
    <MapCtx.Provider value={ctx}>
      <div className="map-view">
        <div className="map-top">
          <p className="map-summary">{map.summary}</p>
          <div className="code-search map-search">
            <Icon name="search" size={14} />
            <input value={search} placeholder="Find a page, route, file…" onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button className="btn sm" onClick={build} disabled={building} title={`Drawn ${timeAgo(map.builtAt)}`}>
            {building ? <span className="spinner" /> : <Icon name="refresh" size={13} />} {stale ? 'Code changed · Redraw' : 'Redraw'}
          </button>
        </div>
        {building && (
          <div className="map-building">
            <span className="spinner" /> {progress.at(-1) ?? 'Starting'}…
          </div>
        )}

        <div className="map-stage">
          <ReactFlowProvider>
            <MapCanvas map={map} sel={sel} setSel={setSel} answer={shown} walk={walk} search={search} ctx={ctx} />
          </ReactFlowProvider>

          {(item || shown) && (
            <aside className={`map-side ${walk ? 'wide' : ''}`}>
              {item ? (
                <>
                  <div className="ms-top">
                    {shown && (
                      <button className="ms-back" onClick={() => setSel(null)}>
                        <Icon name="chevronLeft" size={13} /> Back to the answer
                      </button>
                    )}
                    <span className="ms-kind">{shown ? '' : item.kind}</span>
                    <span className="spacer" />
                    <button className="icon-btn sm" onClick={() => (setSel(null), show(null))} aria-label="Close">
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                  <h3>{item.name}</h3>
                  {item.route && <code className="ms-route">{item.route}</code>}
                  <p>{item.summary}</p>
                  <button className="ms-file" onClick={() => onOpenFile(item.path, item.line)}>
                    <Icon name="file" size={13} /> {item.path}
                    {item.line ? `:${item.line}` : ''}
                    <Icon name="external" size={12} />
                  </button>
                  {!!item.fields?.length && (
                    <div className="ms-links">
                      <div className="ds-label">Fields</div>
                      <div className="ms-fields">
                        {item.fields.map((f) => (
                          <div key={f.name}>
                            <code>{f.name}</code>
                            <em>{f.type}</em>
                            {f.note && <span>{f.note}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {zoom ? (
                    <div className="ms-links">
                      <div className="ds-label">Inside</div>
                      {zoom.parts.map((p, i) => (
                        <button key={i} className="ms-part" onClick={() => onOpenFile(p.path, p.line)}>
                          <code>{p.name}</code>
                          <span>{p.summary}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    !item.fields?.length && (
                      <button className="btn sm" onClick={() => !expanded.has(item.id) && toggle(item.id)} disabled={zooming.has(item.id)}>
                        {zooming.has(item.id) ? <span className="spinner" /> : <Icon name="chevronDown" size={13} />} Open up: files and functions inside
                      </button>
                    )
                  )}
                  {links.length > 0 && (
                    <div className="ms-links">
                      <div className="ds-label">Connected to</div>
                      {links.map((l, i) => {
                        const other = l.from === item.id ? l.to : l.from;
                        return (
                          <button key={i} className="ms-link" onClick={() => setSel(other)}>
                            <span className="faint">{l.from === item.id ? (l.label ?? 'uses') : `${l.label ?? 'used'} by`}</span> {nameOf(other)}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <button className="btn sm" onClick={() => ask(`What happens when ${item.name} is used? Walk me through it with sample data.`)} disabled={asking}>
                    <Icon name="play" size={12} /> Walk through it
                  </button>
                </>
              ) : shown ? (
                <>
                  <div className="ms-top">
                    <span className="ms-kind">{shown.trace ? 'Walkthrough' : 'Answer'}</span>
                    <span className="spacer" />
                    <SaveBar a={shown} onSave={(n) => saveFlow(shown, n)} />
                    <button className="icon-btn sm" onClick={() => show(null)} aria-label="Close">
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                  <h3 className="ms-q">{shown.question}</h3>
                  {shown.commit && head && shown.commit !== head && (
                    <div className="ms-stale">
                      <span>The code changed since this was worked out.</span>
                      <button className="linkish" onClick={() => ask(shown.question, shown)} disabled={asking}>
                        {asking ? 'Refreshing…' : 'Refresh it'}
                      </button>
                    </div>
                  )}
                  {shown.trace ? (
                    <details className="ms-short" open={step < 0}>
                      <summary>In short</summary>
                      <Md text={shown.answer} />
                    </details>
                  ) : (
                    <Md text={shown.answer} />
                  )}
                  {shown.trace && <CheckCard a={shown} board={board} onStart={() => runCheck(shown)} onOpen={onOpenThread} />}
                  {shown.trace ? (
                    <Walkthrough
                      trace={shown.trace}
                      step={step}
                      setStep={(n) => (setPlaying(false), setStep(n))}
                      open={onOpenFile}
                      nameOf={nameOf}
                      playing={playing}
                      setPlaying={setPlaying}
                    />
                  ) : (
                    shown.focus.length > 0 && (
                      <div className="ms-links">
                        <div className="ds-label">On the map</div>
                        {shown.focus.map((id, i) => (
                          <button key={id} className="ms-link" onClick={() => setSel(id)}>
                            <span className="mi-order">{i + 1}</span> {nameOf(id)}
                          </button>
                        ))}
                      </div>
                    )
                  )}
                </>
              ) : null}
              {savedFlows.some((a) => a.at !== shown?.at) && !item && (
                <div className="ms-links">
                  <div className="ds-label">Saved flows</div>
                  {savedFlows
                    .filter((a) => a.at !== shown?.at)
                    .map((a) => (
                      <button key={a.at} className="ms-link" onClick={() => show(a)}>
                        <Icon name="bookmark" size={11} /> {a.saved!.name}
                      </button>
                    ))}
                </div>
              )}
              {answers.some((a) => !a.saved && a.at !== shown?.at) && !item && (
                <div className="ms-links">
                  <div className="ds-label">Earlier questions</div>
                  {answers
                    .filter((a) => !a.saved && a.at !== shown?.at)
                    .map((a) => (
                      <div key={a.at} className="ms-earlier">
                        <button className="ms-link" onClick={() => show(a)}>
                          {a.trace && <Icon name="play" size={10} />} {a.question}
                        </button>
                        <button className="icon-btn sm" onClick={() => forget(a)} aria-label="Forget" title="Forget">
                          <Icon name="x" size={12} />
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </aside>
          )}

          <div className="map-ask">
            {asking && (
              <div className="map-progress small">
                <span className="spinner" /> {progress.at(-1) ?? 'Thinking'}…
              </div>
            )}
            {!asking && !shown && !sel && (
              <div className="map-suggest">
                {savedFlows.length > 0 && (
                  <>
                    <span className="faint small">Saved</span>
                    {savedFlows.map((a) => (
                      <button key={a.at} className="saved" onClick={() => show(a)} title={a.question}>
                        <Icon name="bookmark" size={10} fill="currentColor" /> {a.saved!.name}
                      </button>
                    ))}
                    <span className="map-suggest-break" />
                  </>
                )}
                <span className="faint small">Walk through</span>
                {flows.filter((f) => !savedFlows.some((a) => a.question === f.question)).map((f) => (
                  <button key={f.question} onClick={() => ask(f.question)} title={f.question}>
                    <Icon name="play" size={10} /> {f.name}
                  </button>
                ))}
                {answers.length > 0 && (
                  <button className="ghost" onClick={() => show(answers[0])}>
                    Last answer
                  </button>
                )}
              </div>
            )}
            <div className="map-ask-box">
              <Icon name="spark" size={16} />
              <textarea
                ref={box}
                rows={1}
                value={q}
                placeholder="Ask how something works… “What happens at checkout?”"
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    ask();
                  }
                }}
              />
              <button className="send-btn" onClick={() => ask()} disabled={!q.trim() || asking} aria-label="Ask">
                {asking ? <span className="spinner light" /> : <Icon name="send" size={17} strokeWidth={2.25} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </MapCtx.Provider>
  );
}
