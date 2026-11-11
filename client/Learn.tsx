import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AREA_HINTS, CONCEPT_AREAS, conceptKey, topicOf, type CanvasNode, type Lesson, type TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { CodeBlock, Md, isFresh } from './nodes.tsx';
import { request, send, toast, useStore } from './store.ts';
import { Segmented, timeAgo, useIsMobile, useTick } from './ui.tsx';
import { plain } from './tree.ts';

// One idea only: concepts. A title, a plain explanation, and the real code behind it.

/** Mark a concept as understood: it leaves the step views and stays in Concepts. */
export const reviewConcept = (l: Lesson, reviewed = true) => {
  send({ type: 'reviewConcept', key: l.key || conceptKey(l.title), reviewed });
  if (reviewed) toast('Got it. You\'ll find it in Concepts.');
};

export function ConceptCard({ lesson, onOpenFile, compact, review }: { lesson: Lesson; onOpenFile?: (path: string) => void; compact?: boolean; review?: boolean }) {
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
        {review && (
          <span
            role="button"
            tabIndex={0}
            className="concept-got"
            title="Got it: clear it from here (it stays in Concepts)"
            aria-label="Got it"
            onClick={(e) => {
              e.stopPropagation();
              reviewConcept(lesson);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                reviewConcept(lesson);
              }
            }}
          >
            <Icon name="check" size={12} strokeWidth={2.6} />
          </span>
        )}
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
                    <CodeBlock className="code concept-snippet" code={lesson.snippet} />
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
  const all = turns.flatMap((t) => (t.lessons ?? []).filter((l) => !l.reviewed)).sort((a, b) => a.at - b.at);
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
      {current ? <ConceptCard key={current.id} lesson={current} onOpenFile={onOpenFile} review /> : working && <MentorWorking />}
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
  /** Every lesson about it is marked "Got it". */
  reviewed: boolean;
}

export function groupConcepts(nodes: Record<string, CanvasNode>): ConceptGroup[] {
  const groups = new Map<string, ConceptGroup>();
  const all = Object.values(nodes)
    .flatMap((n) => (n.kind === 'turn' ? (n.lessons ?? []).map((l) => ({ l, t: n })) : []))
    .sort((a, b) => a.l.at - b.l.at);
  for (const x of all) {
    const key = x.l.key || conceptKey(x.l.title);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, lesson: x.l, area: x.l.area, related: new Set(), seen: [], last: x.l.at, reviewed: true }));
    if (!x.l.reviewed) g.reviewed = false;
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

// ---- the Concepts page: shelves by topic, a clear card per idea, and practice to remember ----

const ACRONYMS = new Set(['http', 'https', 'css', 'html', 'api', 'sql', 'ui', 'url', 'json', 'dom', 'jwt', 'cors', 'ci', 'cd', 'dns', 'tcp', 'io', 'cli', 'svg', 'xss', 'csrf', 'orm', 'ssr', 'npm', 'rest', 'pr', 'hmac', 'sso', 'sdk', 'aws', 'ssh', 'tls', 'ssl', 'qa', 'db', 'id', 'ip', 'llm', 'ttl', 'utc', 'uuid', 'crud', 'rpc', 'grpc', 'trpc', 'cdn', 'cpu', 'gpu', 'mfa', 'otp', 'rbac', 'saml', 'yaml', 'csv', 'pdf', 'dto', 'env', 'e2e']);
// Names with their own spelling: "git worktree" → "Git worktree", not "GIT worktree".
const SPELLED: Record<string, string> = { git: 'Git', github: 'GitHub', oauth: 'OAuth', graphql: 'GraphQL', javascript: 'JavaScript', typescript: 'TypeScript', postgres: 'Postgres', webhook: 'webhook', websocket: 'WebSocket', nextjs: 'Next.js', react: 'React', redis: 'Redis', docker: 'Docker' };
/** "http caching" → "HTTP caching": the short name of a concept. */
export const conceptName = (g: ConceptGroup) =>
  g.lesson.key
    ? g.key
        .split(' ')
        .map((w, i) => {
          const lw = w.toLowerCase();
          const fixed = ACRONYMS.has(lw) ? lw.toUpperCase() : SPELLED[lw];
          if (fixed) return i === 0 ? fixed[0].toUpperCase() + fixed.slice(1) : fixed;
          return i === 0 && w ? w[0].toUpperCase() + w.slice(1) : w;
        })
        .join(' ')
    : g.lesson.title.split(':')[0];

/** The rest of the explanation, after the one-line gist (so it isn't said twice). */
const afterGist = (body: string) => {
  const g = gist(body);
  const t = body.trim();
  return t.startsWith(g) ? t.slice(g.length).trim() : t;
};

/** The idea in one line: the first sentence of its explanation. */
const gist = (body: string) => {
  const t = plain(body).replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,180}?[.!?])(\s|$)/);
  return m ? m[1] : t.slice(0, 160);
};

const AREA_COLORS: Record<string, string> = {
  'Problem solving': '#c084fc',
  'The language': '#8b9cff',
  'Code structure': '#5ec8e5',
  Screens: '#f472b6',
  'Servers & APIs': '#3ecf8e',
  Data: '#f5a524',
  Speed: '#facc15',
  Safety: '#ff7a90',
  'Testing & debugging': '#2dd4bf',
  'Tools & shipping': '#94a3b8',
};
const AREA_ICONS: Record<string, string> = {
  'Problem solving': 'spark',
  'The language': 'code',
  'Code structure': 'grid',
  Screens: 'canvas',
  'Servers & APIs': 'branch',
  Data: 'folder',
  Speed: 'refresh',
  Safety: 'shield',
  'Testing & debugging': 'check',
  'Tools & shipping': 'terminal',
};
const UNSORTED = 'Not sorted yet';
/** A steady colour per topic. */
export const areaColor = (a: string) => AREA_COLORS[topicOf(a) ?? ''] ?? 'var(--text-3)';
const topic = (g: ConceptGroup) => topicOf(g.area) ?? UNSORTED;

/** How well you know it, from practice: 0 new … 4 solid. */
const strength = (g: ConceptGroup) => Math.max(0, ...g.seen.map((x) => x.l.memory?.box ?? 0));
const due = (g: ConceptGroup) => Math.min(...g.seen.map((x) => x.l.memory?.due ?? 0));
const STRENGTH = ['New', 'Learning', 'Getting there', 'Know it', 'Solid'];

function Strength({ g }: { g: ConceptGroup }) {
  const s = strength(g);
  return (
    <span className="strength" title={`${STRENGTH[s]} · practice to strengthen it`}>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={i <= s ? 'on' : ''} />
      ))}
    </span>
  );
}

let organizedThisSession = false;

export function LearnLibrary({ onOpen }: { onOpen: (t: TurnNode) => void }) {
  useTick();
  const { nodes } = useStore();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [practice, setPractice] = useState(false);
  const groups = useMemo(() => groupConcepts(nodes), [nodes]);
  const byKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups]);

  // Concepts from before topics existed get sorted once, quietly.
  useEffect(() => {
    if (organizedThisSession || !groups.some((g) => !topicOf(g.area))) return;
    organizedThisSession = true;
    request<number>({ type: 'organizeConcepts' }).catch(() => {});
  }, [groups.length]);

  const needle = q.trim().toLowerCase();
  const shown = groups.filter((g) => !needle || `${conceptName(g)} ${g.lesson.title} ${g.lesson.body} ${topic(g)}`.toLowerCase().includes(needle));
  const shelves = [...CONCEPT_AREAS, UNSORTED].map((a) => ({ area: a as string, items: shown.filter((g) => topic(g) === a) })).filter((x) => x.items.length);
  const current = sel ? byKey.get(sel) : undefined;
  const dueNow = groups.filter((g) => due(g) <= Date.now());

  if (!groups.length)
    return (
      <div className="library">
        <div className="empty-note">
          <span className="mentor-orb big" />
          <div>
            As agents work, you'll pick up the ideas behind their code.
            <br />
            They collect here, sorted by topic, so they're easy to find and remember.
          </div>
        </div>
      </div>
    );

  return (
    <div className="library v2">
      <div className="lib-head">
        <div className="lib-count">
          <b>{groups.length}</b> idea{groups.length === 1 ? '' : 's'} learned
          <span className="faint"> · {groups.filter((g) => strength(g) >= 3).length} you know well</span>
        </div>
        <div className="code-search lib-search">
          <Icon name="search" size={14} />
          <input value={q} placeholder="Search ideas…" onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn sm primary" onClick={() => setPractice(true)} disabled={!groups.length}>
          <Icon name="spark" size={13} /> Practice{dueNow.length ? ` · ${Math.min(dueNow.length, 10)}` : ''}
        </button>
      </div>

      <div className="shelves">
        {shelves.map(({ area, items }) => (
          <section key={area} className="shelf" style={{ ['--topic' as any]: areaColor(area) }}>
            <header className="shelf-head">
              <span className="shelf-icon">
                <Icon name={(AREA_ICONS[area] ?? 'spark') as any} size={14} />
              </span>
              <div>
                <h3>
                  {area} <span className="shelf-count">{items.length}</span>
                </h3>
                <p>{AREA_HINTS[area] ?? 'Waiting to be sorted into a topic.'}</p>
              </div>
            </header>
            <div className="shelf-row">
              {items.map((g) => (
                <button key={g.key} className={`idea-card ${sel === g.key ? 'on' : ''}`} onClick={() => setSel(g.key)}>
                  <span className="idea-name">{conceptName(g)}</span>
                  <span className="idea-gist">{gist(g.lesson.body)}</span>
                  <span className="idea-foot">
                    <Strength g={g} />
                    <span className="spacer" />
                    {new Set(g.seen.map((x) => x.t.id)).size > 1 ? `seen ${new Set(g.seen.map((x) => x.t.id)).size}×` : timeAgo(g.last)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}
        {!shelves.length && <div className="faint pad">Nothing matches “{q}”.</div>}
      </div>

      {current && <IdeaSheet g={current} all={byKey} onPick={setSel} onOpen={onOpen} onClose={() => setSel(null)} />}
      {practice && <Practice groups={groups} onClose={() => setPractice(false)} />}
    </div>
  );
}

/** One idea, opened: the gist in big type, the explanation, your code, where you met it. */
function IdeaSheet({ g, all, onPick, onOpen, onClose }: { g: ConceptGroup; all: Map<string, ConceptGroup>; onPick: (k: string) => void; onOpen: (t: TurnNode) => void; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [onClose]);
  const t = topic(g);
  return (
    <div className="idea-sheet-bg" onClick={onClose}>
      <div className="idea-sheet" style={{ ['--topic' as any]: areaColor(t) }} onClick={(e) => e.stopPropagation()}>
        <div className="is-top">
          <span className="is-topic">
            <i /> {t}
          </span>
          <span className="spacer" />
          <Strength g={g} />
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        <h2 className="is-name">{conceptName(g)}</h2>
        <p className="is-gist">{gist(g.lesson.body)}</p>
        {afterGist(g.lesson.body) && (
          <div className="is-body">
            <Md text={afterGist(g.lesson.body)} />
          </div>
        )}
        {g.lesson.snippet && (
          <div className="is-block">
            <div className="is-label">
              In your code
              {g.lesson.file && (
                <>
                  {' · '}
                  <span className="is-file" title={g.lesson.file}>
                    {g.lesson.file}
                  </span>
                </>
              )}
            </div>
            <CodeBlock className="code concept-snippet" code={g.lesson.snippet} />
          </div>
        )}
        {g.related.size > 0 && (
          <div className="is-block">
            <div className="is-label">Goes with</div>
            <div className="cmap-pills">
              {[...g.related].map((k) => (
                <button key={k} className="cmap-pill linked" onClick={() => onPick(k)}>
                  {all.has(k) ? conceptName(all.get(k)!) : k}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="is-block">
          <div className="is-label">Where you met it</div>
          <SeenIn g={g} onOpen={onOpen} />
        </div>
      </div>
    </div>
  );
}

/** Flashcards: the name first, think, then flip. What you know comes back less often. */
function Practice({ groups, onClose }: { groups: ConceptGroup[]; onClose: () => void }) {
  const [deck] = useState(() => {
    const now = Date.now();
    const dueFirst = groups.filter((g) => due(g) <= now).sort((a, b) => strength(a) - strength(b) || due(a) - due(b));
    const rest = groups.filter((g) => due(g) > now).sort((a, b) => due(a) - due(b));
    return [...dueFirst, ...rest].slice(0, 10);
  });
  const [i, setI] = useState(0);
  const [flip, setFlip] = useState(false);
  const [knew, setKnew] = useState(0);
  const g = deck[i];
  const answer = (k: boolean) => {
    send({ type: 'practiceConcept', key: g.key, knew: k });
    if (k) setKnew((n) => n + 1);
    setFlip(false);
    setI(i + 1);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      } else if (g && (e.key === ' ' || e.key === 'Enter') && !flip) {
        e.preventDefault();
        setFlip(true);
      } else if (g && flip && (e.key === 'ArrowRight' || e.key === 'k')) answer(true);
      else if (g && flip && (e.key === 'ArrowLeft' || e.key === 'n')) answer(false);
    };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  });
  return (
    <div className="idea-sheet-bg" onClick={onClose}>
      <div className="practice" onClick={(e) => e.stopPropagation()}>
        <div className="is-top">
          <span className="faint small">{g ? `${i + 1} of ${deck.length}` : 'Done'}</span>
          <div className="practice-bar">
            <i style={{ width: `${(i / deck.length) * 100}%` }} />
          </div>
          <button className="icon-btn sm" onClick={onClose} aria-label="Close">
            <Icon name="x" size={15} />
          </button>
        </div>
        {g ? (
          <div className={`flashcard ${flip ? 'flipped' : ''}`} style={{ ['--topic' as any]: areaColor(topic(g)) }}>
            <div className="fc-topic">
              <i /> {topic(g)}
            </div>
            <div className="fc-name">{conceptName(g)}</div>
            {!flip ? (
              <>
                <p className="fc-ask">What does it mean, and why would you use it?</p>
                <button className="btn primary" onClick={() => setFlip(true)}>
                  Show me <kbd>Space</kbd>
                </button>
              </>
            ) : (
              <>
                <p className="fc-gist">{gist(g.lesson.body)}</p>
                {afterGist(g.lesson.body) && (
                  <div className="fc-body">
                    <Md text={afterGist(g.lesson.body)} />
                  </div>
                )}
                <div className="fc-actions">
                  <button className="btn" onClick={() => answer(false)}>
                    Not yet <kbd>←</kbd>
                  </button>
                  <button className="btn primary" onClick={() => answer(true)}>
                    I knew it <kbd>→</kbd>
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flashcard done">
            <span className="mentor-orb big" />
            <div className="fc-name">
              {knew} of {deck.length} known
            </div>
            <p className="fc-ask">What you knew comes back in a few days. The rest comes back sooner.</p>
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
