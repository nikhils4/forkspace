import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CONCEPT_AREAS, conceptKey, type CanvasNode, type Lesson, type TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { Md, isFresh } from './nodes.tsx';
import { request, toast, useStore } from './store.ts';
import { Segmented, timeAgo, useTick } from './ui.tsx';
import { plain } from './tree.ts';

// One idea only: concepts. A title, a plain explanation, and the real code behind it.

export function ConceptCard({ lesson, onOpenFile, compact }: { lesson: Lesson; onOpenFile?: (path: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const [code, setCode] = useState(false);
  // Promoted to the top of a stack (the one above was dismissed): open it.
  useEffect(() => setOpen(!compact), [compact]);

  return (
    <div className={`concept ${open ? 'open' : ''} ${isFresh(lesson.at) ? 'fresh' : ''}`}>
      <button className="concept-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="mentor-orb small" />
        <span className="concept-title">{lesson.title}</span>
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
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [min, setMin] = useState(false);
  const all = turns.flatMap((t) => t.lessons ?? []).sort((a, b) => b.at - a.at);
  const shown = all.filter((l) => !hidden.has(l.id)).slice(0, 3);
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
      {working && <MentorWorking />}
      {shown.map((l, i) => (
        <div key={l.id} className="dock-item">
          <ConceptCard lesson={l} onOpenFile={onOpenFile} compact={i > 0} />
          <button className="dock-x" onClick={() => setHidden(new Set([...hidden, l.id]))} aria-label="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
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
  const [view, setView] = useState<'list' | 'map'>(() => {
    try {
      return (localStorage.getItem('forkspace:concepts-view') as 'list' | 'map') || 'list';
    } catch {
      return 'list';
    }
  });
  const pick = (v: 'list' | 'map') => {
    setView(v);
    try {
      localStorage.setItem('forkspace:concepts-view', v);
    } catch {}
  };
  const groups = useMemo(() => groupConcepts(nodes), [nodes]);
  const needle = q.trim().toLowerCase();
  const shown = groups.filter((g) => !needle || `${g.lesson.title} ${g.lesson.body} ${g.key} ${g.area ?? ''}`.toLowerCase().includes(needle));

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
        </div>
        <Segmented<'list' | 'map'>
          value={view}
          onChange={pick}
          options={[
            { value: 'list', label: 'List' },
            { value: 'map', label: 'Map' },
          ]}
        />
      </div>
      {view === 'list' ? (
        <>
          <div className="code-search lib-search">
            <Icon name="spark" size={14} />
            <input value={q} placeholder="Search concepts…" onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="lib-list">
            {shown.map((g) => (
              <div key={g.key} className="lib-item">
                <ConceptCard lesson={g.lesson} compact />
                <SeenIn g={g} onOpen={onOpen} />
              </div>
            ))}
            {!shown.length && <div className="faint pad">No concepts match.</div>}
          </div>
        </>
      ) : (
        <ConceptMap groups={groups} onOpen={onOpen} />
      )}
    </div>
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
function ConceptMap({ groups, onOpen }: { groups: ConceptGroup[]; onOpen: (t: TurnNode) => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [sorting, setSorting] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ d: string; k: string }[]>([]);
  const byKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups]);
  const current = sel ? byKey.get(sel) : undefined;

  // Older concepts have no area yet: sort them once, in the background.
  const untagged = groups.filter((g) => !g.area).length;
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
    <div className={`cmap ${current ? 'has-sel' : ''}`}>
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
          <div key={area} className="cmap-area">
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
      <aside className="cmap-side">
        {current ? (
          <>
            <div className="cmap-side-area">
              {conceptName(current)} · {current.area ?? 'Not sorted yet'}
            </div>
            <ConceptCard lesson={current.lesson} />
            {current.related.size > 0 && (
              <div className="cmap-links">
                <span className="faint small">Connects to</span>
                <div className="cmap-pills">
                  {[...current.related].map((k) => (
                    <button key={k} className="cmap-pill linked" onClick={() => setSel(k)}>
                      {byKey.has(k) ? conceptName(byKey.get(k)!) : k}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <SeenIn g={current} onOpen={onOpen} />
          </>
        ) : (
          <div className="cmap-hint">
            <span className="mentor-orb" />
            <p>Pick a concept to read it, see what it connects to, and jump to where you learned it.</p>
          </div>
        )}
      </aside>
    </div>
  );
}
