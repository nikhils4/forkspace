import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CONCEPT_AREAS, conceptKey, type CanvasNode, type Lesson, type TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { Md, isFresh } from './nodes.tsx';
import { request, toast, useStore } from './store.ts';
import { Segmented, timeAgo, useIsMobile, useTick } from './ui.tsx';
import { plain } from './tree.ts';

// One idea only: concepts. A title, a plain explanation, and the real code behind it.

export function ConceptCard({ lesson, onOpenFile, compact }: { lesson: Lesson; onOpenFile?: (path: string) => void; compact?: boolean }) {
  // Decided once, when the card appears. After that only you open or close it: nothing new
  // arriving ever folds away the one you're reading. One you just asked for opens itself.
  const [open, setOpen] = useState(() => !compact || (!!lesson.asked && Date.now() - lesson.at < 15_000));
  const [code, setCode] = useState(false);
  const [seen, setSeen] = useState(open);

  return (
    <div className={`concept ${open ? 'open' : ''} ${isFresh(lesson.at) ? 'fresh' : ''}`}>
      <button
        className="concept-head"
        onClick={() => {
          setOpen(!open);
          setSeen(true);
        }}
        aria-expanded={open}
      >
        <span className="mentor-orb small" />
        <span className="concept-title">{lesson.title}</span>
        {!seen && Date.now() - lesson.at < 10 * 60_000 && <span className="concept-new">New</span>}
        <Icon name="chevronDown" size={14} className="concept-chev" />
      </button>
      <div className="fold">
        <div className="fold-inner">
          <div className="concept-body">
            <Md text={lesson.body} />
            {lesson.snippet && (
              <>
                <button className="link-btn concept-code-toggle" onClick={() => setCode(!code)}>
                  {code ? 'Hide the code' : 'See the code'}
                </button>
                <div className={`fold ${code ? 'open' : ''}`}>
                  <div className="fold-inner">
                    <pre className="code concept-snippet">{lesson.snippet}</pre>
                  </div>
                </div>
              </>
            )}
            {lesson.file && onOpenFile && (
              <button className="concept-file" onClick={() => onOpenFile(lesson.file!)}>
                <Icon name="file" size={12} /> {lesson.file}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Kept for existing imports. */
export const LessonCard = ConceptCard;

export function MentorWorking({ label = 'Finding a concept…' }: { label?: string }) {
  return (
    <div className="mentor-working">
      <span className="mentor-orb" />
      <span className="shimmer-text">{label}</span>
    </div>
  );
}

/** Floating stack of the newest concepts, over the code. */
export function MentorDock({ turns, onOpenFile }: { turns: TurnNode[]; onOpenFile: (p: string) => void }) {
  const [min, setMin] = useState(false);
  const all = turns.flatMap((t) => t.lessons ?? []).sort((a, b) => a.at - b.at);
  // The one you're reading stays put. New ones wait behind a "new" button until you want them.
  const [readId, setReadId] = useState<string | null>(null);
  const [seenCount, setSeenCount] = useState(0);
  useEffect(() => {
    if (!readId && all.length) {
      setReadId(all[all.length - 1].id);
      setSeenCount(all.length);
    }
  }, [all.length, readId]);
  const idx = Math.max(0, all.findIndex((l) => l.id === readId));
  const current = all[idx];
  const fresh = Math.max(0, all.length - seenCount);
  const go = (i: number) => {
    const l = all[Math.max(0, Math.min(all.length - 1, i))];
    if (!l) return;
    setReadId(l.id);
    setSeenCount((c) => Math.max(c, all.findIndex((x) => x.id === l.id) + 1));
  };
  const working = turns.some((t) => t.learning);
  if (!all.length && !working) return null;

  if (min)
    return (
      <button className="mentor-pill" onClick={() => setMin(false)}>
        <span className="mentor-orb small" />
        Concepts
        <span className="count">{all.length}</span>
      </button>
    );

  return (
    <div className="mentor-dock">
      <div className="mentor-dock-head">
        <span>Concepts</span>
        <span className="spacer" />
        <button className="icon-btn sm" onClick={() => setMin(true)} aria-label="Minimise">
          <Icon name="chevronDown" size={14} />
        </button>
      </div>
      {current ? <ConceptCard key={current.id} lesson={current} onOpenFile={onOpenFile} /> : working && <MentorWorking />}
      {all.length > 0 && (
        <div className="dock-nav">
          <button className="icon-btn sm" disabled={idx <= 0} onClick={() => go(idx - 1)} aria-label="Previous concept">
            <Icon name="chevronLeft" size={14} />
          </button>
          <span className="faint small">
            {idx + 1} of {all.length}
          </span>
          <button className="icon-btn sm" disabled={idx >= all.length - 1} onClick={() => go(idx + 1)} aria-label="Next concept">
            <Icon name="chevronRight" size={14} />
          </button>
          <span className="spacer" />
          {working && current && <span className="faint small shimmer-text">Finding one more…</span>}
          {fresh > 0 && (
            <button className="dock-new" onClick={() => go(all.length - 1)}>
              {fresh} new
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Every concept you have picked up, across boards. */
/** One entry per concept: lessons with the same key are the same idea, seen in several steps. */
export interface ConceptGroup {
  key: string;
  lesson: Lesson;
  area?: string;
  related: Set<string>;
  seen: { l: Lesson; t: TurnNode }[];
  last: number;
}

export function groupConcepts(nodes: Record<string, CanvasNode>): ConceptGroup[] {
  const groups = new Map<string, ConceptGroup>();
  const all = Object.values(nodes)
    .flatMap((n) => (n.kind === 'turn' ? (n.lessons ?? []).map((l) => ({ l, t: n })) : []))
    .sort((a, b) => a.l.at - b.l.at);
  for (const x of all) {
    const key = x.l.key || conceptKey(x.l.title);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, lesson: x.l, area: x.l.area, related: new Set(), seen: [], last: x.l.at }));
    g.area ??= x.l.area;
    for (const r of x.l.related ?? []) g.related.add(r);
    g.seen.push(x);
    g.last = Math.max(g.last, x.l.at);
  }
  // Links go both ways.
  for (const g of groups.values()) for (const r of g.related) groups.get(r)?.related.add(g.key);
  for (const g of groups.values()) for (const r of [...g.related]) if (!groups.has(r) || r === g.key) g.related.delete(r);
  return [...groups.values()].sort((a, b) => b.last - a.last);
}

function SeenIn({ g, onOpen }: { g: ConceptGroup; onOpen: (t: TurnNode) => void }) {
  const { boards } = useStore();
  const steps = [...new Map(g.seen.map((x) => [x.t.id, x])).values()].reverse();
  return (
    <div className="seen-in">
      <span className="faint small">{steps.length === 1 ? 'From' : `Seen in ${steps.length} steps`}</span>
      {steps.slice(0, 4).map(({ t, l }) => (
        <button key={t.id} className="seen-chip" onClick={() => onOpen(t)} title={t.prompt}>
          {boards.find((b) => b.id === t.boardId)?.name} · {plain(t.prompt).slice(0, 38)}
          {plain(t.prompt).length > 38 ? '…' : ''} <span className="faint">{timeAgo(l.at)}</span>
        </button>
      ))}
    </div>
  );
}

export function LearnLibrary({ onOpen }: { onOpen: (t: TurnNode) => void }) {
  useTick();
  const { nodes } = useStore();
  const [q, setQ] = useState('');
  const [area, setArea] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<'map' | 'list'>(() => {
    try {
      return (localStorage.getItem('forkspace:concepts-view2') as 'map' | 'list') || 'map';
    } catch {
      return 'map';
    }
  });
  const pick = (v: 'map' | 'list') => {
    setView(v);
    try {
      localStorage.setItem('forkspace:concepts-view2', v);
    } catch {}
  };
  const groups = useMemo(() => groupConcepts(nodes), [nodes]);
  const byKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups]);
  const areas = useMemo(() => {
    const order = [...CONCEPT_AREAS, 'Not sorted yet'] as string[];
    return [...new Set(groups.map((g) => g.area ?? 'Not sorted yet'))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }, [groups]);
  const needle = q.trim().toLowerCase();
  const shown = groups.filter(
    (g) => (!area || (g.area ?? 'Not sorted yet') === area) && (!needle || `${g.lesson.title} ${g.lesson.body} ${g.key} ${g.area ?? ''}`.toLowerCase().includes(needle)),
  );
  const current = sel ? byKey.get(sel) : undefined;

  if (!groups.length)
    return (
      <div className="library">
        <div className="empty-note">
          <span className="mentor-orb big" />
          <div>
            As agents work, you'll pick up the concepts behind their code.
            <br />
            They collect here, each one once.
          </div>
        </div>
      </div>
    );

  return (
    <div className="library">
      <div className="lib-head">
        <div className="lib-count">
          <b>{groups.length}</b> concept{groups.length === 1 ? '' : 's'}
          <span className="faint"> · {areas.length} area{areas.length === 1 ? '' : 's'}</span>
        </div>
        <div className="code-search lib-search">
          <Icon name="spark" size={14} />
          <input value={q} placeholder="Search concepts…" onChange={(e) => setQ(e.target.value)} />
        </div>
        <Segmented<'map' | 'list'>
          value={view}
          onChange={pick}
          options={[
            { value: 'map', label: 'Map' },
            { value: 'list', label: 'List' },
          ]}
        />
      </div>
      <div className="lib-areas">
        <button className={`area-chip ${!area ? 'on' : ''}`} onClick={() => setArea(null)}>
          All
        </button>
        {areas.map((a) => (
          <button key={a} className={`area-chip ${area === a ? 'on' : ''}`} onClick={() => setArea(area === a ? null : a)}>
            <i style={{ background: areaColor(a) }} />
            {a}
          </button>
        ))}
      </div>

      <div className={`lib-body ${current ? 'has-sel' : ''}`}>
        <div className="lib-main">
          {view === 'map' ? (
            <ConceptMapView groups={shown} all={byKey} sel={sel} setSel={setSel} />
          ) : (
            <div className="concept-grid">
              {shown.map((g) => (
                <button key={g.key} className={`concept-tile ${sel === g.key ? 'on' : ''}`} onClick={() => setSel(sel === g.key ? null : g.key)}>
                  <span className="tile-area">
                    <i style={{ background: areaColor(g.area ?? 'Not sorted yet') }} />
                    {g.area ?? 'Not sorted yet'}
                  </span>
                  <span className="tile-name">{conceptName(g)}</span>
                  <span className="tile-body">{g.lesson.body}</span>
                  <span className="tile-foot">
                    {(() => {
                      const steps = new Set(g.seen.map((x) => x.t.id)).size;
                      return steps > 1 ? `Seen in ${steps} steps` : 'Learned once';
                    })()}
                    {g.related.size > 0 && ` · ${g.related.size} link${g.related.size === 1 ? '' : 's'}`}
                    <span className="spacer" />
                    {timeAgo(g.last)}
                  </span>
                </button>
              ))}
            </div>
          )}
          {!shown.length && <div className="faint pad">No concepts match.</div>}
        </div>
        <aside className="cmap-side">
          {current ? (
            <ConceptDetail g={current} all={byKey} onPick={setSel} onOpen={onOpen} />
          ) : (
            <div className="cmap-hint">
              <span className="mentor-orb" />
              <p>Pick a concept to read it, see what it connects to, and jump to where you learned it.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

const AREA_COLORS = ['#8b9cff', '#3ecf8e', '#f5a524', '#ff7a90', '#5ec8e5', '#c084fc', '#f97316', '#a3e635', '#e879f9', '#38bdf8', '#fbbf24', '#2dd4bf', '#f472b6', '#94a3b8', '#facc15'];
/** A steady colour per area, so the map and list match. */
export const areaColor = (a: string) => {
  const i = (CONCEPT_AREAS as readonly string[]).indexOf(a);
  return i < 0 ? 'var(--text-3)' : AREA_COLORS[i % AREA_COLORS.length];
};

function ConceptDetail({ g, all, onPick, onOpen }: { g: ConceptGroup; all: Map<string, ConceptGroup>; onPick: (k: string) => void; onOpen: (t: TurnNode) => void }) {
  return (
    <>
      <div className="cmap-side-area">
        <i style={{ background: areaColor(g.area ?? '') }} />
        {g.area ?? 'Not sorted yet'}
      </div>
      <h2 className="detail-name">{conceptName(g)}</h2>
      <ConceptCard key={g.key} lesson={g.lesson} />
      {g.related.size > 0 && (
        <div className="cmap-links">
          <span className="faint small">Connects to</span>
          <div className="cmap-pills">
            {[...g.related].map((k) => (
              <button key={k} className="cmap-pill linked" onClick={() => onPick(k)}>
                {all.has(k) ? conceptName(all.get(k)!) : k}
              </button>
            ))}
          </div>
        </div>
      )}
      <SeenIn g={g} onOpen={onOpen} />
    </>
  );
}

let organizedThisSession = false;

const ACRONYMS = new Set(['http', 'https', 'css', 'html', 'api', 'sql', 'ui', 'url', 'json', 'dom', 'jwt', 'cors', 'ci', 'cd', 'dns', 'tcp', 'io', 'cli', 'git', 'svg', 'xss', 'csrf', 'orm', 'ssr', 'npm']);
/** "http caching" → "HTTP caching": the short name shown on the map. */
export const conceptName = (g: ConceptGroup) =>
  g.lesson.key
    ? g.key
        .split(' ')
        .map((w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
        .join(' ')
    : g.lesson.title.split(':')[0];

/** Concepts grouped by where they live in tech, with the links between them. */
function ConceptMap({ groups, all, sel, setSel }: { groups: ConceptGroup[]; all: Map<string, ConceptGroup>; sel: string | null; setSel: (k: string | null) => void }) {
  const [sorting, setSorting] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ d: string; k: string }[]>([]);
  const current = sel ? all.get(sel) : undefined;

  // Older concepts have no area yet: sort them once, in the background.
  const untagged = [...all.values()].filter((g) => !g.area).length;
  useEffect(() => {
    if (!untagged || organizedThisSession) return;
    organizedThisSession = true;
    setSorting(true);
    request<number>({ type: 'organizeConcepts' })
      .catch((e: Error) => toast(e.message, 'error'))
      .finally(() => setSorting(false));
  }, [untagged]);

  const areas = useMemo(() => {
    const m = new Map<string, ConceptGroup[]>();
    for (const g of groups) {
      const a = g.area ?? 'Not sorted yet';
      m.set(a, [...(m.get(a) ?? []), g]);
    }
    const order = [...CONCEPT_AREAS, 'Not sorted yet'] as string[];
    return [...m].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [groups]);

  // Curved lines from the selected concept to the ones it connects to.
  useLayoutEffect(() => {
    const root = wrap.current;
    if (!root || !current) return setLines([]);
    const draw = () => {
      const box = root.getBoundingClientRect();
      const at = (k: string) => {
        const el = root.querySelector(`[data-key="${CSS.escape(k)}"]`) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2 - box.left, y: r.top + r.height / 2 - box.top };
      };
      const a = at(current.key);
      if (!a) return setLines([]);
      const out: { d: string; k: string }[] = [];
      for (const k of current.related) {
        const b = at(k);
        if (!b) continue;
        const mx = (a.x + b.x) / 2;
        const lift = Math.min(80, Math.abs(a.x - b.x) / 3 + 20);
        out.push({ k, d: `M${a.x} ${a.y} Q${mx} ${Math.min(a.y, b.y) - lift} ${b.x} ${b.y}` });
      }
      setLines(out);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(root);
    return () => ro.disconnect();
  }, [current, groups]);

  return (
    <div className="cmap-areas" ref={wrap} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
      <svg className="cmap-lines" aria-hidden>
        {lines.map((l) => (
          <path key={l.k} d={l.d} />
        ))}
      </svg>
      {sorting && (
        <div className="cmap-sorting">
          <span className="mentor-orb small" /> <span className="shimmer-text">Sorting your concepts into the map…</span>
        </div>
      )}
      {areas.map(([area, list]) => (
        <div key={area} className="cmap-area" style={{ ['--area' as any]: areaColor(area) }}>
          <div className="cmap-area-head">
            <span>{area}</span>
            <em>{list.length}</em>
          </div>
          <div className="cmap-pills">
            {list.map((g) => (
              <button
                key={g.key}
                data-key={g.key}
                className={`cmap-pill ${sel === g.key ? 'on' : ''} ${current && current.related.has(g.key) ? 'linked' : ''} ${current && sel !== g.key && !current.related.has(g.key) ? 'dim' : ''}`}
                onClick={() => setSel(sel === g.key ? null : g.key)}
              >
                {conceptName(g)}
                {g.seen.length > 1 && <i>{g.seen.length}</i>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- the spatial map: areas as islands, ideas as bubbles, links between them ----

/** What each area means, in one plain line. */
export const AREA_HINT: Record<string, string> = {
  Algorithms: 'Step-by-step recipes for solving problems',
  'Data structures': 'Ways to organise data so it is quick to use',
  'Language features': 'Tools the programming language gives you',
  Performance: 'Making things faster and lighter',
  Testing: 'Checking the code does what you think',
  Debugging: 'Finding out why something broke',
  'Architecture and design': 'How the pieces fit together',
  'Web and networking': 'How browsers, servers and the internet talk',
  'Data and databases': 'Storing and finding information',
  Security: 'Keeping data and people safe',
  'Concurrency and async': 'Doing several things at once',
  'UI and frontend': 'What people see and touch',
  'Tooling and build': 'The commands and tools around the code',
  'DevOps and infrastructure': 'Running and shipping software',
  'Version control': 'Tracking changes over time',
  'Not sorted yet': 'Being sorted into the map',
};

const firstSentence = (t: string) => (t.match(/^.*?[.!?](\s|$)/)?.[0] ?? t).trim();

function ConceptMapView(props: { groups: ConceptGroup[]; all: Map<string, ConceptGroup>; sel: string | null; setSel: (k: string | null) => void }) {
  const mobile = useIsMobile();
  // Phones get the compact clusters; the spatial map needs room.
  return mobile ? <ConceptMap {...props} /> : <IslandMap {...props} />;
}

const CELL_W = 270;
const CELL_H = 240;
const PAD = 28;

function IslandMap({ groups, all, sel, setSel }: { groups: ConceptGroup[]; all: Map<string, ConceptGroup>; sel: string | null; setSel: (k: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<string | null>(null);
  const [sorting, setSorting] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Older concepts have no area yet: sort them once, in the background.
  const untagged = [...all.values()].filter((g) => !g.area).length;
  useEffect(() => {
    if (!untagged || organizedThisSession) return;
    organizedThisSession = true;
    setSorting(true);
    request<number>({ type: 'organizeConcepts' })
      .catch((e: Error) => toast(e.message, 'error'))
      .finally(() => setSorting(false));
  }, [untagged]);

  const layout = useMemo(() => {
    const byArea = new Map<string, ConceptGroup[]>();
    for (const g of groups) byArea.set(g.area ?? 'Not sorted yet', [...(byArea.get(g.area ?? 'Not sorted yet') ?? []), g]);
    const order = [...CONCEPT_AREAS, 'Not sorted yet'] as string[];
    const areas = [...byArea].sort((a, b) => b[1].length - a[1].length || order.indexOf(a[0]) - order.indexOf(b[0]));
    const cols = Math.max(1, Math.min(3, areas.length));
    const rows = Math.ceil(areas.length / cols);
    const islands = areas.map(([name, list], i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      // A gentle stagger so it reads as a map, not a table.
      const cx = PAD + c * CELL_W + CELL_W / 2 + (r % 2 ? 18 : -18) * (cols > 1 ? 1 : 0);
      const cy = PAD + r * CELL_H + CELL_H / 2 + 16 + (c % 2 ? 14 : -8);
      const step = Math.min(46, 92 / Math.sqrt(Math.max(1, list.length)));
      const sorted = [...list].sort((a, b) => b.seen.length - a.seen.length);
      const nodes = sorted.map((g, j) => {
        const rr = list.length === 1 ? 0 : step * Math.sqrt(j + 0.6);
        const a = j * 2.39996 - Math.PI / 2;
        const W = cols * CELL_W + PAD * 2;
        // Keep every bubble fully inside the map.
        return { g, x: Math.max(PAD + 72, Math.min(W - PAD - 72, cx + rr * Math.cos(a) * 1.35)), y: cy + rr * Math.sin(a) * 0.8 };
      });
      const radius = Math.max(92, step * Math.sqrt(list.length + 0.6) * 1.25 + 64);
      return { name, cx, cy, radius: Math.min(radius, CELL_W / 2 - 6), nodes };
    });
    // Nudge bubbles apart until none overlap, pulling each gently back toward its island.
    const W = cols * CELL_W + PAD * 2;
    const H = rows * CELL_H + PAD * 2;
    const items = islands.flatMap((isl) =>
      isl.nodes.map((n) => {
        const name = conceptName(n.g);
        const w = Math.min(170, name.length * 7.4 + 36);
        return { n, isl, w, h: name.length * 7.4 + 36 > 170 ? 46 : 32 };
      }),
    );
    for (let it = 0; it < 120; it++) {
      for (let i = 0; i < items.length; i++)
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i];
          const b = items[j];
          const ox = (a.w + b.w) / 2 + 10 - Math.abs(a.n.x - b.n.x);
          const oy = (a.h + b.h) / 2 + 8 - Math.abs(a.n.y - b.n.y);
          if (ox <= 0 || oy <= 0) continue;
          if (oy < ox) {
            const d = (oy / 2) * (a.n.y <= b.n.y ? -1 : 1);
            a.n.y += d;
            b.n.y -= d;
          } else {
            const d = (ox / 2) * (a.n.x <= b.n.x ? -1 : 1);
            a.n.x += d;
            b.n.x -= d;
          }
        }
      for (const m of items) {
        m.n.x += (m.isl.cx - m.n.x) * 0.02;
        m.n.y += (m.isl.cy - m.n.y) * 0.02;
        m.n.x = Math.max(PAD + m.w / 2, Math.min(W - PAD - m.w / 2, m.n.x));
        m.n.y = Math.max(PAD + 44, Math.min(H - PAD - m.h / 2, m.n.y));
      }
    }
    const pos = new Map<string, { x: number; y: number; area: string }>();
    for (const isl of islands) for (const n of isl.nodes) pos.set(n.g.key, { x: n.x, y: n.y, area: isl.name });
    const links: { a: string; b: string }[] = [];
    for (const g of groups) for (const r of g.related) if (g.key < r && pos.has(r)) links.push({ a: g.key, b: r });
    return { islands, pos, links, w: cols * CELL_W + PAD * 2, h: rows * CELL_H + PAD * 2 };
  }, [groups]);

  const scale = Math.min(1.15, width / layout.w);
  const focus = hover ?? sel;
  const focusG = focus ? all.get(focus) : undefined;
  const near = (k: string) => !focusG || k === focusG.key || focusG.related.has(k);
  const top = [...layout.islands].sort((a, b) => b.nodes.length - a.nodes.length)[0];
  const tip = hover ? all.get(hover) : undefined;
  const tipPos = hover ? layout.pos.get(hover) : undefined;

  return (
    <div className="island-wrap">
      <p className="island-summary">
        {sorting ? (
          <>
            <span className="mentor-orb small" /> <span className="shimmer-text">Sorting your concepts into the map…</span>
          </>
        ) : (
          <>
            <b>{groups.length}</b> idea{groups.length === 1 ? '' : 's'} across <b>{layout.islands.length}</b> area{layout.islands.length === 1 ? '' : 's'} of software.
            {top && layout.islands.length > 1 && (
              <>
                {' '}You know the most about&nbsp;<b style={{ color: areaColor(top.name) }}>{top.name.toLowerCase()}</b>.
              </>
            )}
          </>
        )}
      </p>
      <div className="island-box" ref={box} style={{ height: layout.h * scale }} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
        <div className="island-stage" style={{ width: layout.w, height: layout.h, transform: `scale(${scale})` }} onClick={(e) => e.target === e.currentTarget && setSel(null)}>
          {layout.islands.map((isl) => (
            <div
              key={isl.name}
              className={`island ${focusG && !isl.nodes.some((n) => near(n.g.key)) ? 'far' : ''}`}
              style={{ left: isl.cx - isl.radius, top: isl.cy - isl.radius * 0.82, width: isl.radius * 2, height: isl.radius * 1.64, ['--area' as any]: areaColor(isl.name) }}
            >
              <div className="island-label">
                <b>{isl.name}</b>
                <span>{AREA_HINT[isl.name] ?? ''}</span>
              </div>
            </div>
          ))}
          <svg className="island-links" width={layout.w} height={layout.h}>
            {layout.links.map(({ a, b }) => {
              const p = layout.pos.get(a)!;
              const q = layout.pos.get(b)!;
              const on = !!focusG && (a === focusG.key || b === focusG.key);
              const mx = (p.x + q.x) / 2;
              const my = (p.y + q.y) / 2 - Math.min(60, Math.hypot(q.x - p.x, q.y - p.y) / 5);
              return <path key={`${a}|${b}`} className={on ? 'on' : focusG ? 'off' : ''} d={`M${p.x} ${p.y} Q${mx} ${my} ${q.x} ${q.y}`} />;
            })}
          </svg>
          {layout.islands.flatMap((isl) =>
            isl.nodes.map(({ g, x, y }) => {
              const seen = new Set(g.seen.map((s) => s.t.id)).size;
              return (
                <button
                  key={g.key}
                  className={`idea ${sel === g.key ? 'on' : ''} ${near(g.key) ? '' : 'dim'} ${focusG && focusG.related.has(g.key) ? 'linked' : ''}`}
                  style={{ left: x, top: y, ['--area' as any]: areaColor(isl.name), ['--size' as any]: `${Math.min(17, 13 + (seen - 1) * 1.5)}px` }}
                  onMouseEnter={() => setHover(g.key)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(g.key)}
                  onBlur={() => setHover(null)}
                  onClick={() => setSel(sel === g.key ? null : g.key)}
                >
                  <i />
                  {conceptName(g)}
                </button>
              );
            }),
          )}
          {tip && tipPos && (
            <div className={`idea-tip ${tipPos.y < 150 ? 'below' : ''}`} style={{ left: Math.max(150, Math.min(layout.w - 150, tipPos.x)), top: tipPos.y }}>
              <b>{conceptName(tip)}</b>
              <span>{firstSentence(tip.lesson.body)}</span>
              {tip.related.size > 0 && <em>Connects to {tip.related.size} other idea{tip.related.size === 1 ? '' : 's'}. Click to read more.</em>}
            </div>
          )}
        </div>
      </div>
      <div className="island-legend">
        <span>
          <i className="lg-dot" /> An idea you learned. Bigger means you met it more often.
        </span>
        <span>
          <i className="lg-line" /> Ideas that work together.
        </span>
        <span>Hover to peek, click to read.</span>
      </div>
    </div>
  );
}
