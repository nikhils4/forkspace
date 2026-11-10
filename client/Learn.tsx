import { useEffect, useMemo, useState } from 'react';
import type { Lesson, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { Md, isFresh } from './nodes.tsx';
import { useStore } from './store.ts';
import { timeAgo, useTick } from './ui.tsx';

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
export function LearnLibrary({ onOpen }: { onOpen: (t: TurnNode) => void }) {
  useTick();
  const { nodes, boards } = useStore();
  const [q, setQ] = useState('');
  const items = useMemo(
    () =>
      Object.values(nodes)
        .flatMap((n) => (n.kind === 'turn' ? (n.lessons ?? []).map((l) => ({ l, t: n })) : []))
        .sort((a, b) => b.l.at - a.l.at),
    [nodes],
  );
  const shown = items.filter((x) => !q.trim() || `${x.l.title} ${x.l.body}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <div className="library">
      {items.length > 0 && (
        <>
          <div className="lib-count">
            <b>{items.length}</b> concept{items.length === 1 ? '' : 's'} learned
          </div>
          <div className="code-search lib-search">
            <Icon name="spark" size={14} />
            <input value={q} placeholder="Search concepts…" onChange={(e) => setQ(e.target.value)} />
          </div>
        </>
      )}
      {!items.length && (
        <div className="empty-note">
          <span className="mentor-orb big" />
          <div>
            As agents work, you'll pick up the concepts behind their code.
            <br />
            They collect here.
          </div>
        </div>
      )}
      <div className="lib-list">
        {shown.map(({ l, t }) => (
          <div key={l.id} className="lib-item">
            <ConceptCard lesson={l} compact />
            <button className="lib-src" onClick={() => onOpen(t)}>
              {boards.find((b) => b.id === t.boardId)?.name} · {timeAgo(l.at)}
            </button>
          </div>
        ))}
        {items.length > 0 && !shown.length && <div className="faint pad">No concepts match.</div>}
      </div>
    </div>
  );
}
