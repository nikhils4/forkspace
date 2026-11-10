import { useEffect, useRef, useState } from 'react';
import type { CardComment, TurnNode } from '../shared/types.ts';
import { composerInsert } from './Composer.tsx';
import { Icon } from './icons.tsx';
import { send, toast } from './store.ts';

// Your own comments on a card: quick thoughts to come back to, like "also handle empty input".
// One click puts a comment into the message box for your next prompt. Only you see them;
// they are never sent to the agent unless you put them in a prompt.

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

export function CardComments({ node, roomy = false }: { node: TurnNode; roomy?: boolean }) {
  const list = node.comments ?? [];
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);

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

  if (!list.length && !adding && !roomy) return null;
  return (
    <div className={`card-comments nodrag nowheel ${roomy ? 'roomy' : 'side'}`}>
      {list.map((c) =>
        editing === c.id ? (
          <CommentBox
            key={c.id}
            initial={c.text}
            onDone={(t) => {
              setEditing(null);
              if (t === null) return;
              save(node, t.trim() ? list.map((x) => (x.id === c.id ? { ...x, text: t.trim() } : x)) : list.filter((x) => x.id !== c.id));
            }}
          />
        ) : (
          <div key={c.id} className="cmt">
            <div className="cmt-text" onDoubleClick={() => setEditing(c.id)} title="Double-click to edit">
              {c.text}
            </div>
            <div className="cmt-tools">
              <button onClick={() => composerInsert(c.text)} title="Add to my next prompt" aria-label="Add to my next prompt">
                <Icon name="send" size={12} />
              </button>
              <button onClick={() => copy(c.text)} title="Copy" aria-label="Copy comment">
                <Icon name="copy" size={12} />
              </button>
              <button onClick={() => save(node, list.filter((x) => x.id !== c.id))} title="Delete" aria-label="Delete comment">
                <Icon name="trash" size={12} />
              </button>
            </div>
          </div>
        ),
      )}
      {adding ? (
        <CommentBox initial={draft} onDone={add} onChange={setDraft} placeholder="Your comment… (Enter to save, Shift+Enter for a new line)" />
      ) : (
        <div className="cmt-actions">
          <button className="cmt-add" onClick={() => setAdding(true)}>
            <Icon name="plus" size={11} /> Comment
          </button>
          {list.length > 1 && (
            <button className="cmt-add" onClick={() => composerInsert(list.map((c) => `- ${c.text}`).join('\n'))} title="Put every comment into the message box">
              <Icon name="send" size={11} /> All to prompt
            </button>
          )}
        </div>
      )}
    </div>
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
