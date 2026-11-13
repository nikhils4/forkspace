import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CardComment, TurnNode } from '../shared/types.ts';
import { composerInsert } from './Composer.tsx';
import { Icon } from './icons.tsx';
import { send, toast, useStore } from './store.ts';
import { timeAgo, useTick } from './ui.tsx';

// Your own comments on a card: quick thoughts to come back to, like "also handle empty input".
// One click puts a comment into the message box for your next prompt. Only you see them;
// they are never sent to the agent unless you put them in a prompt. Tick one off when it's dealt
// with. The Comments panel on the canvas lists every comment on the board, thread by thread.

const uid = () => Math.random().toString(36).slice(2, 10);

/** Ask a card to open its comment box (from the right-click menu). */
const openers = new Map<string, () => void>();
export const startComment = (nodeId: string) => openers.get(nodeId)?.();

const save = (node: TurnNode, comments: CardComment[]) => send({ type: 'setComments', nodeId: node.id, comments });

const copy = (text: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast('Comment copied'),
    () => toast('Could not copy', 'error'),
  );

export const openCount = (node: TurnNode) => (node.comments ?? []).filter((c) => !c.done).length;

// The Comments panel's open state, shared so a card's "2 done" can open it.
let panelOpen = false;
const panelSubs = new Set<() => void>();
export const setCommentsPanel = (open: boolean) => {
  panelOpen = open;
  panelSubs.forEach((f) => f());
};
export const useCommentsPanel = () =>
  useSyncExternalStore(
    (f) => {
      panelSubs.add(f);
      return () => void panelSubs.delete(f);
    },
    () => panelOpen,
  );

/** One comment: its text (double-click to edit), when, and what you can do with it. */
function CommentItem({ node, c, showTime = false }: { node: TurnNode; c: CardComment; showTime?: boolean }) {
  const list = node.comments ?? [];
  const [editing, setEditing] = useState(false);
  const update = (patch: Partial<CardComment> | null) => save(node, patch ? list.map((x) => (x.id === c.id ? { ...x, ...patch } : x)) : list.filter((x) => x.id !== c.id));
  if (editing)
    return (
      <CommentBox
        initial={c.text}
        onDone={(t) => {
          setEditing(false);
          if (t === null) return;
          update(t.trim() ? { text: t.trim() } : null);
        }}
      />
    );
  return (
    <div className={`cmt ${c.done ? 'done' : ''}`}>
      <div className="cmt-row">
        <button className={`cmt-tick ${c.done ? 'on' : ''}`} onClick={() => update({ done: !c.done })} title={c.done ? 'Not done yet' : 'Mark done'} aria-label={c.done ? 'Mark not done' : 'Mark done'}>
          {c.done && <Icon name="check" size={10} strokeWidth={3} />}
        </button>
        <div className="cmt-text" onDoubleClick={() => setEditing(true)} title="Double-click to edit">
          {c.text}
        </div>
      </div>
      {showTime && <div className="cmt-when">{timeAgo(c.at)}</div>}
      <div className="cmt-tools">
        <button onClick={() => composerInsert(c.text)} title="Add to my next prompt" aria-label="Add to my next prompt">
          <Icon name="send" size={12} />
        </button>
        <button onClick={() => copy(c.text)} title="Copy" aria-label="Copy comment">
          <Icon name="copy" size={12} />
        </button>
        <button onClick={() => update(null)} title="Delete" aria-label="Delete comment">
          <Icon name="trash" size={12} />
        </button>
      </div>
    </div>
  );
}

/**
 * The comments on one card. On the canvas (side) they sit beside the card and show only what's
 * still open; in the details panel (roomy) every comment shows, done ones crossed out.
 */
export function CardComments({ node, roomy = false }: { node: TurnNode; roomy?: boolean }) {
  useTick();
  const list = node.comments ?? [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (roomy) return;
    const open = () => setAdding(true);
    openers.set(node.id, open);
    return () => {
      if (openers.get(node.id) === open) openers.delete(node.id);
    };
  }, [node.id, roomy]);

  const add = (t: string | null) => {
    if (t?.trim()) save(node, [...list, { id: uid(), text: t.trim(), at: Date.now() }]);
    setDraft('');
    setAdding(false);
  };

  const open = list.filter((c) => !c.done);
  const done = list.length - open.length;
  const shown = roomy ? list : open;
  if (!shown.length && !adding && !(roomy || done)) return null;
  return (
    <div className={`card-comments nodrag nowheel ${roomy ? 'roomy' : 'side'}`}>
      {shown.map((c) => (
        <CommentItem key={c.id} node={node} c={c} showTime={roomy} />
      ))}
      {adding ? (
        <CommentBox initial={draft} onDone={add} onChange={setDraft} placeholder="Your comment… (Enter to save, Shift+Enter for a new line)" />
      ) : (
        <div className={`cmt-actions ${!roomy && !open.length ? 'always' : ''}`}>
          <button className="cmt-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={11} /> Comment
          </button>
          {open.length > 1 && (
            <button className="cmt-add" onClick={() => composerInsert(open.map((c) => `- ${c.text}`).join('\n'))} title="Put every open comment into the message box">
              <Icon name="send" size={11} /> All to prompt
            </button>
          )}
          {!roomy && done > 0 && (
            <button className="cmt-add cmt-done-chip" onClick={() => setCommentsPanel(true)} title="See them in the Comments panel">
              <Icon name="check" size={11} /> {done} done
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Every comment on a board, grouped by thread, newest thread first. */
export function CommentsPanel({ boardId, onGo, onClose }: { boardId: string; onGo: (nodeId: string) => void; onClose: () => void }) {
  useTick();
  const { nodes } = useStore();
  const [show, setShow] = useState<'open' | 'done'>('open');

  const { groups, openTotal, doneTotal } = useMemo(() => {
    const turn = (id?: string | null) => (id ? (nodes[id] as TurnNode | undefined) : undefined);
    const rootOf = (n: TurnNode) => {
      let cur = n;
      let depth = 1;
      for (let p = turn(cur.parentId); p && p.kind === 'turn'; p = turn(p.parentId)) {
        cur = p;
        depth++;
      }
      return { root: cur, depth };
    };
    const byRoot = new Map<string, { root: TurnNode; steps: { node: TurnNode; depth: number; list: CardComment[] }[]; latest: number }>();
    let openTotal = 0;
    let doneTotal = 0;
    for (const n of Object.values(nodes)) {
      if (n.kind !== 'turn' || n.boardId !== boardId || !n.comments?.length) continue;
      const t = n as TurnNode;
      openTotal += t.comments!.filter((c) => !c.done).length;
      doneTotal += t.comments!.filter((c) => c.done).length;
      const list = t.comments!.filter((c) => (show === 'done' ? c.done : !c.done));
      if (!list.length) continue;
      const { root, depth } = rootOf(t);
      const g = byRoot.get(root.id) ?? { root, steps: [], latest: 0 };
      g.steps.push({ node: t, depth, list });
      g.latest = Math.max(g.latest, ...list.map((c) => c.at));
      byRoot.set(root.id, g);
    }
    const groups = [...byRoot.values()].sort((a, b) => b.latest - a.latest);
    groups.forEach((g) => g.steps.sort((a, b) => a.depth - b.depth || a.node.createdAt - b.node.createdAt));
    return { groups, openTotal, doneTotal };
  }, [nodes, boardId, show]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.note-sheet, .ctx')) return;
      const t = e.target as HTMLElement;
      if (t.closest('textarea, input')) return;
      e.stopImmediatePropagation();
      onClose();
    };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [onClose]);

  return (
    <aside className="cmt-panel nodrag nowheel" onPointerDown={(e) => e.stopPropagation()}>
      <header className="cmtp-head">
        <div className="cmtp-title">
          <Icon name="comment" size={15} />
          <b>Comments</b>
        </div>
        <div className="cmtp-tabs" role="tablist">
          <button role="tab" aria-selected={show === 'open'} className={show === 'open' ? 'on' : ''} onClick={() => setShow('open')}>
            Open <span>{openTotal}</span>
          </button>
          <button role="tab" aria-selected={show === 'done'} className={show === 'done' ? 'on' : ''} onClick={() => setShow('done')}>
            Done <span>{doneTotal}</span>
          </button>
        </div>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" size={15} />
        </button>
      </header>

      <div className="cmtp-body">
        {!groups.length ? (
          <div className="cmtp-empty">
            {show === 'open' ? (
              <>
                <Icon name="comment" size={24} />
                <b>{doneTotal ? 'All done' : 'No comments yet'}</b>
                <p>Hover a card and press the + on its edge to jot a thought for later. Only you see them, until you send one to a prompt.</p>
              </>
            ) : (
              <p>Comments you tick off land here.</p>
            )}
          </div>
        ) : (
          groups.map((g) => {
            const open = g.steps.flatMap((s) => s.list).filter((c) => !c.done);
            return (
              <section key={g.root.id} className="cmtp-thread">
                <div className="cmtp-thread-head">
                  <span className="cmtp-thread-title ellipsis">{g.root.title || g.root.prompt}</span>
                  {show === 'open' && open.length > 1 && (
                    <button className="cmt-add" onClick={() => composerInsert(open.map((c) => `- ${c.text}`).join('\n'))} title="Put this thread's open comments into the message box">
                      <Icon name="send" size={11} /> All to prompt
                    </button>
                  )}
                </div>
                {g.steps.map((s) => (
                  <div key={s.node.id} className="cmtp-step">
                    <button className="cmtp-step-head" onClick={() => onGo(s.node.id)} title="Show this card">
                      <span className="cmtp-n">{s.depth}</span>
                      <span className="ellipsis">{s.node.prompt}</span>
                      <Icon name="chevronRight" size={12} />
                    </button>
                    <div className="cmtp-list">
                      {s.list.map((c) => (
                        <CommentItem key={c.id} node={s.node} c={c} showTime />
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            );
          })
        )}
      </div>
    </aside>
  );
}

function CommentBox({ initial, onDone, onChange, placeholder = 'Edit comment…' }: { initial: string; onDone: (t: string | null) => void; onChange?: (t: string) => void; placeholder?: string }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const finished = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(v.length, v.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [v]);
  const done = (t: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(t);
  };
  return (
    <textarea
      ref={ref}
      className="cmt-input"
      rows={1}
      value={v}
      placeholder={placeholder}
      onChange={(e) => {
        setV(e.target.value);
        onChange?.(e.target.value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          done(v);
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          done(v.trim() && v !== initial ? v : null);
        }
      }}
      onBlur={() => done(v.trim() ? v : null)}
    />
  );
}
