import { useEffect, useMemo, useState } from 'react';
import type { Lesson, LessonKind, TurnNode } from '../shared/types.ts';
import { Icon, type IconName } from './icons.tsx';
import { Md } from './nodes.tsx';
import { useStore } from './store.ts';
import { timeAgo, useTick } from './ui.tsx';

export const KIND: Record<LessonKind, { label: string; icon: IconName; color: string }> = {
  concept: { label: 'Concept', icon: 'spark', color: '#8b9cff' },
  why: { label: 'Why this way', icon: 'chat', color: '#2dd4e6' },
  pattern: { label: 'Pattern', icon: 'grid', color: '#3ecf8e' },
  watch: { label: 'Watch out', icon: 'shield', color: '#f5a524' },
  explain: { label: 'Explained', icon: 'code', color: '#b18cff' },
};

// ---- quick-check answers, remembered per device ----
const ANS_KEY = 'forkspace:checks';
function readAnswers(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(ANS_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveAnswer(id: string, i: number) {
  try {
    localStorage.setItem(ANS_KEY, JSON.stringify({ ...readAnswers(), [id]: i }));
  } catch {}
}

function Check({ lesson }: { lesson: Lesson }) {
  const c = lesson.check!;
  const [picked, setPicked] = useState<number | undefined>(() => readAnswers()[lesson.id]);
  const [open, setOpen] = useState(picked != null);
  const done = picked != null;
  if (!open)
    return (
      <button className="check-open" onClick={() => setOpen(true)}>
        <Icon name="spark" size={13} /> Test yourself
        <span className="faint">one quick question</span>
      </button>
    );
  return (
    <div className="check">
      <div className="check-q">
        <Icon name="spark" size={13} /> {c.question}
      </div>
      <div className="check-opts">
        {c.options.map((o, i) => (
          <button
            key={i}
            disabled={done}
            className={`check-opt ${done && i === c.answer ? 'right' : ''} ${done && i === picked && i !== c.answer ? 'wrong' : ''}`}
            onClick={() => {
              setPicked(i);
              saveAnswer(lesson.id, i);
            }}
          >
            {o}
          </button>
        ))}
      </div>
      {done && (
        <div className={`check-result ${picked === c.answer ? 'right' : 'wrong'}`}>
          <b>{picked === c.answer ? 'Nice, that’s it.' : 'Not quite.'}</b> {c.why ?? ''}
        </div>
      )}
    </div>
  );
}

export function LessonCard({ lesson, onOpenFile, compact }: { lesson: Lesson; onOpenFile?: (path: string) => void; compact?: boolean }) {
  const k = KIND[lesson.kind] ?? KIND.concept;
  const [open, setOpen] = useState(!compact);
  // Promoted to the top of a stack (e.g. the note above was dismissed): open it.
  useEffect(() => setOpen(!compact), [compact]);
  return (
    <div className={`lesson ${compact ? 'compact' : ''}`} style={{ ['--k' as any]: k.color }}>
      <button className="lesson-head" onClick={() => compact && setOpen(!open)}>
        <span className="lesson-icon">
          <Icon name={k.icon} size={13} />
        </span>
        <span className="lesson-head-text">
          <span className="lesson-kind">{k.label}</span>
          <span className="lesson-title">{lesson.title}</span>
        </span>
        {compact && <Icon name="chevronDown" size={13} className={`lesson-chev ${open ? 'open' : ''}`} />}
      </button>
      {open && (
        <div className="lesson-body">
          <Md text={lesson.body} />
          {lesson.snippet && <pre className="code lesson-snippet">{lesson.snippet}</pre>}
          {lesson.check && <Check lesson={lesson} />}
          {lesson.file && onOpenFile && (
            <button className="lesson-file" onClick={() => onOpenFile(lesson.file!)}>
              <Icon name="file" size={12} /> {lesson.file}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function MentorWorking({ label = 'Mentor is writing a note…' }: { label?: string }) {
  return (
    <div className="mentor-working">
      <span className="mentor-orb" />
      <span className="shimmer-text">{label}</span>
    </div>
  );
}

/** Floating stack of the newest lessons, over the code. */
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
        Learning
        <span className="count">{all.length}</span>
      </button>
    );

  return (
    <div className="mentor-dock">
      <div className="mentor-dock-head">
        <span className="mentor-orb small" />
        <span>Learning</span>
        <span className="faint">{all.length ? `${all.length} note${all.length === 1 ? '' : 's'}` : ''}</span>
        <span className="spacer" />
        <button className="icon-btn sm" onClick={() => setMin(true)} aria-label="Minimise">
          <Icon name="chevronDown" size={14} />
        </button>
      </div>
      {working && <MentorWorking />}
      {shown.map((l, i) => (
        <div key={l.id} className="dock-item" style={{ ['--i' as any]: i }}>
          <LessonCard lesson={l} onOpenFile={onOpenFile} compact={i > 0} />
          <button className="dock-x" onClick={() => setHidden(new Set([...hidden, l.id]))} aria-label="Dismiss">
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Everything you have learned, across boards. */
export function LearnLibrary({ onOpen }: { onOpen: (t: TurnNode) => void }) {
  useTick();
  const { nodes, boards } = useStore();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<LessonKind | 'all'>('all');
  const items = useMemo(
    () =>
      Object.values(nodes)
        .flatMap((n) => (n.kind === 'turn' ? (n.lessons ?? []).map((l) => ({ l, t: n })) : []))
        .sort((a, b) => b.l.at - a.l.at),
    [nodes],
  );
  const answers = readAnswers();
  const checks = items.filter((x) => x.l.check);
  const right = checks.filter((x) => answers[x.l.id] === x.l.check!.answer).length;
  const shown = items.filter(
    (x) => (kind === 'all' || x.l.kind === kind) && (!q.trim() || `${x.l.title} ${x.l.body}`.toLowerCase().includes(q.trim().toLowerCase())),
  );

  return (
    <div className="library">
      <div className="lib-stats">
        <div className="lib-stat">
          <b>{items.length}</b>
          <span>notes</span>
        </div>
        <div className="lib-stat">
          <b>{items.filter((x) => x.l.at > Date.now() - 7 * 86400000).length}</b>
          <span>this week</span>
        </div>
        <div className="lib-stat">
          <b>
            {right}/{checks.length}
          </b>
          <span>checks right</span>
        </div>
      </div>
      <div className="lib-filters">
        <div className="code-search lib-search">
          <Icon name="spark" size={14} />
          <input value={q} placeholder="Search what you’ve learned…" onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="lib-kinds">
          {(['all', 'concept', 'why', 'pattern', 'watch', 'explain'] as const).map((k) => (
            <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : KIND[k].label}
            </button>
          ))}
        </div>
      </div>
      {!items.length && (
        <div className="empty-note">
          <span className="mentor-orb big" />
          <div>
            With Learn mode on, a mentor explains the ideas behind what your agents do, as they do it.
            <br />
            Everything you learn collects here.
          </div>
        </div>
      )}
      <div className="lib-list">
        {shown.map(({ l, t }) => (
          <div key={l.id} className="lib-item">
            <LessonCard lesson={l} compact />
            <button className="lib-src" onClick={() => onOpen(t)}>
              {boards.find((b) => b.id === t.boardId)?.name} · {timeAgo(l.at)} · <span className="ellipsis">{t.prompt}</span>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
