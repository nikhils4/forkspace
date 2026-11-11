import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { Board, CodeMap, MapAnswer } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { Md } from './nodes.tsx';
import { onMapProgress, request, toast } from './store.ts';
import { useResolvedTheme } from './theme.ts';
import { timeAgo, useTick } from './ui.tsx';

// The project as a map: screens, API routes, logic and data in lanes, with lines for what uses
// what. Click a piece to read about it; ask a question and the parts that matter light up.

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
  model: 'folder',
  job: 'refresh',
  config: 'settings',
  module: 'code',
};
const ITEM_W = 250;
const ITEM_H = 58;
const GAP = 12;
const LANE_PAD = 16;
const LANE_HEAD = 64;
const LANE_GAP = 90;

type ItemData = { item: Item; color: string; state: 'focus' | 'near' | 'dim' | '' ; order?: number };
type LaneData = { layer: Layer; color: string; count: number; height: number };

const ItemNode = memo(function ItemNode({ data }: NodeProps<Node<ItemData>>) {
  const { item, color, state, order } = data;
  return (
    <div className={`map-item ${state}`} style={{ ['--lane' as any]: color }}>
      <Handle type="target" position={Position.Left} className="mi-handle" isConnectable={false} />
      <Handle type="source" position={Position.Right} className="mi-handle" isConnectable={false} />
      <span className="mi-icon">
        <Icon name={(KIND_ICON[item.kind] ?? 'code') as any} size={13} />
      </span>
      <span className="mi-text">
        <b className="ellipsis">{item.name}</b>
        <span className="ellipsis">{item.route ?? item.path}</span>
      </span>
      {order ? <span className="mi-order">{order}</span> : null}
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

function layout(map: CodeMap) {
  const lanes = [...map.layers].sort((a, b) => LANE_ORDER.indexOf(a.kind) - LANE_ORDER.indexOf(b.kind));
  const pos = new Map<string, { x: number; y: number }>();
  const laneNodes: Node<LaneData>[] = [];
  lanes.forEach((l, i) => {
    const items = map.items.filter((it) => it.layer === l.id);
    const x = i * (ITEM_W + LANE_PAD * 2 + LANE_GAP);
    const height = LANE_HEAD + items.length * (ITEM_H + GAP) + LANE_PAD;
    laneNodes.push({ id: `lane-${l.id}`, type: 'lane', position: { x, y: 0 }, data: { layer: l, color: LANE_COLOR[l.kind] ?? '#94a3b8', count: items.length, height }, draggable: false, selectable: false, zIndex: -1, style: { width: ITEM_W + LANE_PAD * 2 } });
    items.forEach((it, j) => pos.set(it.id, { x: x + LANE_PAD, y: LANE_HEAD + j * (ITEM_H + GAP) }));
  });
  return { lanes, laneNodes, pos };
}

function MapCanvas({ map, sel, setSel, answer, search }: { map: CodeMap; sel: string | null; setSel: (id: string | null) => void; answer: MapAnswer | null; search: string }) {
  const rf = useReactFlow();
  const theme = useResolvedTheme();
  const { lanes, laneNodes, pos } = useMemo(() => layout(map), [map]);
  const laneColor = useMemo(() => new Map(lanes.map((l) => [l.id, LANE_COLOR[l.kind] ?? '#94a3b8'])), [lanes]);
  const needle = search.trim().toLowerCase();
  const focus = answer?.focus ?? [];
  const near = useMemo(() => {
    const s = new Set<string>();
    if (sel) for (const l of map.links) if (l.from === sel || l.to === sel) s.add(l.from === sel ? l.to : l.from);
    return s;
  }, [sel, map]);

  const nodes: Node[] = useMemo(() => {
    const items: Node<ItemData>[] = map.items.map((it) => {
      const hit = needle ? `${it.name} ${it.path} ${it.route ?? ''} ${it.summary}`.toLowerCase().includes(needle) : true;
      const inFocus = focus.includes(it.id);
      const state: ItemData['state'] = it.id === sel || inFocus ? 'focus' : near.has(it.id) ? 'near' : (sel || focus.length || needle) && !(needle && hit) ? 'dim' : needle && hit ? 'near' : '';
      return { id: it.id, type: 'item', position: pos.get(it.id) ?? { x: 0, y: 0 }, data: { item: it, color: laneColor.get(it.layer) ?? '#94a3b8', state, order: inFocus && focus.length > 1 ? focus.indexOf(it.id) + 1 : undefined }, draggable: false, width: ITEM_W, height: ITEM_H };
    });
    return [...laneNodes, ...items];
  }, [map, pos, laneNodes, laneColor, sel, focus.join(), near, needle]);

  const edges: Edge[] = useMemo(() => {
    // A piece you clicked: its own lines. An answer: only the lines between the parts it names.
    const f = new Set(focus);
    const isOn = (l: CodeMap['links'][number]) => (sel ? l.from === sel || l.to === sel : f.size > 0 && f.has(l.from) && f.has(l.to));
    const any = !!sel || f.size > 0;
    return map.links.map((l, i) => {
      const on = isOn(l);
      return {
        id: `e${i}`,
        source: l.from,
        target: l.to,
        type: 'default',
        label: on ? l.label : undefined,
        className: on ? 'map-edge on' : any ? 'map-edge off' : 'map-edge',
        zIndex: on ? 5 : 0,
      };
    });
  }, [map, sel, focus.join()]);

  // An answer arrives: bring the parts it's about into view.
  useEffect(() => {
    if (!focus.length) return;
    const t = setTimeout(() => rf.fitView({ nodes: focus.map((id) => ({ id })), duration: 600, padding: 0.35, maxZoom: 1.1 }), 80);
    return () => clearTimeout(t);
  }, [answer?.at]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      colorMode={theme}
      onNodeClick={(_, n) => n.type === 'item' && setSel(n.id === sel ? null : n.id)}
      onPaneClick={() => setSel(null)}
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

export function MapView({ board, onOpenFile }: { board: Board; onOpenFile: (path: string) => void }) {
  useTick();
  const [map, setMap] = useState<CodeMap | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [asking, setAsking] = useState(false);
  const [answers, setAnswers] = useState<MapAnswer[]>([]);
  const [shown, setShown] = useState<MapAnswer | null>(null);
  const [search, setSearch] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setLoading(true);
    setMap(null);
    setSel(null);
    setAnswers([]);
    setShown(null);
    request<{ map: CodeMap | null; stale: boolean }>({ type: 'mapGet', boardId: board.id }).then(
      (r) => {
        setMap(r.map);
        setStale(r.stale);
        setLoading(false);
      },
      () => setLoading(false),
    );
  }, [board.id]);
  useEffect(() => onMapProgress((m) => m.boardId === board.id && setProgress((p) => [...p.slice(-5), m.text])), [board.id]);

  const build = async () => {
    setBuilding(true);
    setProgress([]);
    try {
      const r = await request<{ map: CodeMap; stale: boolean }>({ type: 'mapBuild', boardId: board.id });
      setMap(r.map);
      setStale(false);
      setSel(null);
      setShown(null);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setBuilding(false);
  };

  const ask = async (question = q) => {
    const text = question.trim();
    if (!text || asking) return;
    setAsking(true);
    setProgress([]);
    setSel(null);
    try {
      const a = await request<MapAnswer>({ type: 'mapAsk', boardId: board.id, question: text });
      setAnswers((l) => [a, ...l].slice(0, 20));
      setShown(a);
      setQ('');
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setAsking(false);
  };

  const item = sel && map ? map.items.find((i) => i.id === sel) : undefined;
  const links = item && map ? map.links.filter((l) => l.from === item.id || l.to === item.id) : [];
  const nameOf = (id: string) => map?.items.find((i) => i.id === id)?.name ?? id;

  if (loading) return <div className="map-empty"><span className="spinner" /></div>;
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
          <p>Claude reads the project (it never changes anything) and draws a map: the screens, the API routes, the logic and the data behind them, and what calls what. Then ask it anything.</p>
          {building ? (
            <div className="map-progress">
              <span className="spinner" />
              <span>{progress.at(-1) ?? 'Starting'}…</span>
            </div>
          ) : (
            <button className="btn primary" onClick={build} disabled={!board.repoRoot && false}>
              <Icon name="spark" size={14} /> Draw the map
            </button>
          )}
          <p className="faint small">Takes a minute or two on a big project. Uses your Claude Code login.</p>
        </div>
      </div>
    );

  return (
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
          <MapCanvas map={map} sel={sel} setSel={setSel} answer={shown} search={search} />
        </ReactFlowProvider>

        {(item || shown) && (
          <aside className="map-side">
            {item ? (
              <>
                <div className="ms-top">
                  <span className="ms-kind">{item.kind}</span>
                  <span className="spacer" />
                  <button className="icon-btn sm" onClick={() => setSel(null)} aria-label="Close">
                    <Icon name="x" size={14} />
                  </button>
                </div>
                <h3>{item.name}</h3>
                {item.route && <code className="ms-route">{item.route}</code>}
                <p>{item.summary}</p>
                <button className="ms-file" onClick={() => onOpenFile(item.path)}>
                  <Icon name="file" size={13} /> {item.path}
                  {item.line ? `:${item.line}` : ''}
                  <Icon name="external" size={12} />
                </button>
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
                <button
                  className="btn sm"
                  onClick={() => {
                    setQ(`How does ${item.name} work, and what happens when it's used?`);
                    setTimeout(() => box.current?.focus(), 0);
                  }}
                >
                  <Icon name="chat" size={13} /> Ask about this
                </button>
              </>
            ) : shown ? (
              <>
                <div className="ms-top">
                  <span className="ms-kind">Answer</span>
                  <span className="spacer" />
                  <button className="icon-btn sm" onClick={() => setShown(null)} aria-label="Close">
                    <Icon name="x" size={14} />
                  </button>
                </div>
                <h3 className="ms-q">{shown.question}</h3>
                <Md text={shown.answer} />
                {shown.focus.length > 0 && (
                  <div className="ms-links">
                    <div className="ds-label">On the map</div>
                    {shown.focus.map((id, i) => (
                      <button key={id} className="ms-link" onClick={() => setSel(id)}>
                        <span className="mi-order">{i + 1}</span> {nameOf(id)}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : null}
            {answers.length > 1 && !item && (
              <div className="ms-links">
                <div className="ds-label">Earlier questions</div>
                {answers
                  .filter((a) => a !== shown)
                  .map((a) => (
                    <button key={a.at} className="ms-link" onClick={() => setShown(a)}>
                      {a.question}
                    </button>
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
          <div className="map-ask-box">
            <Icon name="spark" size={16} />
            <textarea
              ref={box}
              rows={1}
              value={q}
              placeholder="Ask about this codebase… “Where is checkout handled?”"
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
          {!answers.length && !asking && (
            <div className="map-suggest">
              {['How does a request flow from a page to the database?', 'Where is login handled?', 'What does each API route do?'].map((s) => (
                <button key={s} onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
