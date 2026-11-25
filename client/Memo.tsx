import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { send } from './store.ts';

// Your own sticky note on a task: a reminder, a to-do, what to check later. It sits at the top of the
// step list so it's always in view. Saves as you type. The agent never sees it.

const EDIT = 'forkspace:memo-edit';
/** Open the note on the task being read (the N key). */
export const editMemo = () => dispatchEvent(new Event(EDIT));

export function TaskMemo({ root }: { root: TurnNode }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(root.memo ?? '');
  const box = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Someone else (another tab, the phone) changed it while we weren't typing.
  useEffect(() => {
    if (!editing) setText(root.memo ?? '');
  }, [root.memo, editing]);
  useEffect(() => {
    const f = () => setEditing(true);
    addEventListener(EDIT, f);
    return () => removeEventListener(EDIT, f);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Grow with the text.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.min(320, innerHeight * 0.3))}px`;
  }, [text, editing]);

  const save = (v: string) => {
    clearTimeout(timer.current);
    if (v.trim() !== (root.memo ?? '').trim()) send({ type: 'setTaskMemo', nodeId: root.id, memo: v });
  };
  const change = (v: string) => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(v), 600);
  };
  const done = () => {
    save(text);
    setEditing(false);
  };

  if (!editing && !text.trim())
    return (
      <button className="memo-add" onClick={() => setEditing(true)} title="Add a note to this task (N)">
        <Icon name="note" size={13} /> Add a note
      </button>
    );
  return (
    <div className={`memo ${editing ? 'editing' : ''}`}>
      {editing ? (
        <textarea
          ref={box}
          autoFocus
          value={text}
          placeholder="A reminder, a to-do, what to check…"
          onChange={(e) => change(e.target.value)}
          onBlur={done}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) (e.preventDefault(), e.currentTarget.blur());
          }}
          aria-label="Your note on this task"
        />
      ) : (
        <button className="memo-text" onClick={() => setEditing(true)} title="Edit note (N)">
          {text}
        </button>
      )}
    </div>
  );
}
