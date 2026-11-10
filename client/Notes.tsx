import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Board, NoteNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { NOTE_COLORS, NoteText } from './nodes.tsx';
import { ShotThumb, openShots } from './Shots.tsx';
import { send, toast, useStore } from './store.ts';
import { timeAgo, useTick } from './ui.tsx';

// Notes: the ones you keep for later (on-call duties, setup steps, links), off the canvas but
// a click away. Notes you want in front of you stay on the canvas.

const uid = () => Math.random().toString(36).slice(2, 12);
const titleOf = (n: NoteNode) => n.text.split('\n').find((l) => l.trim())?.replace(/^#+\s*|^[-*] (\[[ xX]\] )?/g, '') || 'Untitled note';

export function NotesPage({ board, onBack }: { board?: Board; onBack?: () => void }) {
  useTick();
  const { nodes, boards } = useStore();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const filed = useMemo(
    () => Object.values(nodes).filter((n): n is NoteNode => n.kind === 'note' && !!n.filed).sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)),
    [nodes],
  );
  const needle = q.trim().toLowerCase();
  const shown = filed.filter((n) => !needle || n.text.toLowerCase().includes(needle));
  const current = open ? (nodes[open] as NoteNode | undefined) : undefined;
  const boardName = (id: string) => boards.find((b) => b.id === id)?.name ?? '';

  const create = () => {
    const b = board ?? boards[0];
    if (!b) return toast('Create a board first.');
    const note: NoteNode = { kind: 'note', id: uid(), boardId: b.id, text: '', color: NOTE_COLORS[0], position: { x: 0, y: 0 }, width: 220, height: 160, createdAt: Date.now(), filed: true };
    send({ type: 'upsertNote', note });
    setOpen(note.id);
  };

  return (
    <div className="notes-page">
      <div className="notes-head">
        <div className="lib-count">
          <b>{filed.length}</b> note{filed.length === 1 ? '' : 's'}
        </div>
        <div className="code-search lib-search">
          <Icon name="search" size={14} />
          <input value={q} placeholder="Search notes…" onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn sm primary" onClick={create}>
          <Icon name="plus" size={13} /> New note
        </button>
      </div>

      {!filed.length ? (
        <div className="empty-note">
          <Icon name="folder" size={26} />
          <div>
            Keep notes here for later, like on-call steps or setup commands.
            <br />
            On the canvas, use the folder button on a note to move it here.
          </div>
        </div>
      ) : (
        <div className="notes-grid">
          {shown.map((n) => {
            const tasks = n.text.match(/^\s*[-*] \[( |x|X)\]/gm) ?? [];
            const done = tasks.filter((t) => /\[(x|X)\]/.test(t)).length;
            return (
              <button key={n.id} className={`note-tile ${open === n.id ? 'on' : ''}`} style={{ ['--paper' as any]: n.color }} onClick={() => setOpen(n.id)}>
                <span className="note-tile-title">{titleOf(n)}</span>
                <span className="note-tile-body">{n.text.split('\n').slice(1).join(' ').replace(/[-*] \[[ xX]\] |[#*]/g, ' ').trim() || ' '}</span>
                <span className="note-tile-foot">
                  {tasks.length > 0 && (
                    <span>
                      {done}/{tasks.length} done ·{' '}
                    </span>
                  )}
                  {n.images?.length ? <span>{n.images.length} image{n.images.length === 1 ? '' : 's'} · </span> : null}
                  {boardName(n.boardId)} · {timeAgo(n.updatedAt ?? n.createdAt)}
                </span>
              </button>
            );
          })}
          {!shown.length && <div className="faint pad">No notes match.</div>}
        </div>
      )}

      {current && <NoteEditor key={current.id} note={current} onClose={() => setOpen(null)} boardName={boardName(current.boardId)} />}
    </div>
  );
}

/** A filed note opened big: edit it, tick it, colour it, or send it back to the canvas. */
function NoteEditor({ note, onClose, boardName }: { note: NoteNode; onClose: () => void; boardName: string }) {
  const [text, setText] = useState(note.text);
  const [editing, setEditing] = useState(!note.text);
  const timer = useRef<number | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);
  const save = (patch: Partial<NoteNode>) => send({ type: 'upsertNote', note: { ...note, ...patch } });

  useEffect(() => {
    if (!editing) setText(note.text);
  }, [note.text]);
  useEffect(() => {
    if (editing) setTimeout(() => area.current?.focus(), 0);
  }, [editing]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [editing, onClose]);

  const toggle = (line: number) => {
    const lines = text.split('\n');
    lines[line] = lines[line].replace(/\[( |x|X)\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'));
    const v = lines.join('\n');
    setText(v);
    save({ text: v });
  };

  return (
    <div className="note-editor-bg" onClick={onClose}>
      <div className="note-editor" style={{ ['--paper' as any]: note.color }} onClick={(e) => e.stopPropagation()}>
        <div className="note-editor-bar">
          <span className="faint small">
            {boardName} · edited {timeAgo(note.updatedAt ?? note.createdAt)}
          </span>
          <span className="spacer" />
          {NOTE_COLORS.map((c) => (
            <button key={c} className={`swatch ${c === note.color ? 'on' : ''}`} style={{ background: c }} onClick={() => save({ color: c })} aria-label="Note colour" />
          ))}
          <button
            className="note-tool"
            title="Put back on the canvas"
            aria-label="Put back on the canvas"
            onClick={() => {
              save({ text, filed: false });
              toast('Back on the canvas');
              onClose();
            }}
          >
            <Icon name="canvas" size={13} />
          </button>
          <button
            className="note-tool"
            title="Delete note"
            aria-label="Delete note"
            onClick={() => {
              if (!confirm('Delete this note?')) return;
              send({ type: 'deleteNodes', ids: [note.id] });
              onClose();
            }}
          >
            <Icon name="trash" size={13} />
          </button>
          <button className="note-tool" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icon name="x" size={13} />
          </button>
        </div>
        {editing ? (
          <textarea
            ref={area}
            value={text}
            placeholder={'Write anything…\n# A heading\n- [ ] a checklist item'}
            onBlur={() => {
              setEditing(false);
              clearTimeout(timer.current);
              if (text !== note.text) save({ text });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                (e.target as HTMLTextAreaElement).blur();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                const el = e.currentTarget;
                const before = text.slice(0, el.selectionStart);
                const line = before.slice(before.lastIndexOf('\n') + 1);
                const m = line.match(/^(\s*[-*] (\[[ xX]\] )?)(.*)$/);
                if (!m) return;
                e.preventDefault();
                const prefix = m[1].replace(/\[[xX]\]/, '[ ]');
                const v = !m[3].trim() ? text.slice(0, el.selectionStart - line.length) + text.slice(el.selectionStart) : `${before}\n${prefix}${text.slice(el.selectionStart)}`;
                const caret = !m[3].trim() ? el.selectionStart - line.length : before.length + 1 + prefix.length;
                flushSync(() => setText(v));
                el.setSelectionRange(caret, caret);
              }
            }}
            onChange={(e) => {
              setText(e.target.value);
              clearTimeout(timer.current);
              const v = e.target.value;
              timer.current = window.setTimeout(() => save({ text: v }), 700);
            }}
          />
        ) : (
          <div className="note-editor-view" onClick={() => setEditing(true)} title="Click to edit">
            {text.trim() ? <NoteText text={text} onToggle={toggle} /> : <span className="note-placeholder">Write anything…</span>}
          </div>
        )}
        {!!note.images?.length && (
          <div className="note-images">
            {note.images.map((id, i) => (
              <ShotThumb
                key={id}
                id={id}
                className="note-image"
                onOpen={() =>
                  openShots(
                    note.images!.map((x) => ({ id: x, label: titleOf(note), remove: () => send({ type: 'upsertNote', note: { ...note, images: note.images!.filter((y) => y !== x) } }) })),
                    i,
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
