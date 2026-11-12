import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Branch, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { CodeRefCtx } from './Markdown.tsx';
import { Md } from './nodes.tsx';
import { request, toast, useStore } from './store.ts';
import { timeAgo, useTick } from './ui.tsx';

// Thread notes: one living note per thread (what it's for, what changed, how it works, what was
// decided, what's open), rewritten by Claude after each step. Code in it links to the file.
// When a thread is deleted its note moves to Concepts.

type Open = { branchId: string } | { conceptId: string } | null;
let openState: Open = null;
const subs = new Set<(o: Open) => void>();
const setOpen = (o: Open) => {
  openState = o;
  subs.forEach((f) => f(o));
};
export const openThreadNote = (branchId: string) => setOpen({ branchId });
export const openConcept = (conceptId: string) => setOpen({ conceptId });

let codeOpener: (boardId: string, path: string, line?: number) => void = () => {};
/** How a `path:line` in a note opens: set once by the app. */
export const setCodeOpener = (fn: typeof codeOpener) => (codeOpener = fn);

/** Is this step where its thread (branch) starts? Its note hangs above it. */
export function startsThread(node: TurnNode, nodes: Record<string, unknown>) {
  const parent = node.parentId ? (nodes[node.parentId] as TurnNode | undefined) : undefined;
  return !parent || parent.branchId !== node.branchId;
}

const copy = (text: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast('Copied'),
    () => toast('Could not copy', 'error'),
  );

/** The tab on a thread's first card. */
export function NoteTab({ branchId, inline }: { branchId: string; inline?: boolean }) {
  const branch: Branch | undefined = useStore().branches[branchId];
  const n = branch?.note;
  if (!branch || !n || (!n.markdown && !n.busy)) return null;
  return (
    <button
      className={`tnote-tab nodrag ${inline ? 'inline' : ''} ${n.busy ? 'busy' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        openThreadNote(branch.id);
      }}
      title="This thread's notes: what changed and how it works"
    >
      {n.busy ? <span className="spinner" /> : <Icon name="note" size={12} />}
      <span className="ellipsis">{inline ? (n.busy && !n.markdown ? 'Writing notes…' : 'Notes') : n.busy && !n.markdown ? 'Writing thread notes…' : n.title || 'Thread notes'}</span>
      {n.busy && n.markdown && <em>updating</em>}
    </button>
  );
}

/** A thread's notes in a line, for the details panel and the chat. */
export function NoteBar({ branchId }: { branchId: string }) {
  useTick();
  const { branches } = useStore();
  const n = branches[branchId]?.note;
  if (!n || (!n.markdown && !n.busy)) return null;
  return (
    <button className="tnote-bar" onClick={() => openThreadNote(branchId)}>
      <span className="tnote-bar-icon">{n.busy ? <span className="spinner" /> : <Icon name="note" size={14} />}</span>
      <span className="tnote-bar-text">
        <b className="ellipsis">{n.markdown ? n.title : 'Writing thread notes…'}</b>
        <span className="faint">{n.busy ? 'Updating with the latest step…' : `Thread notes · ${n.steps} step${n.steps === 1 ? '' : 's'} · updated ${timeAgo(n.updatedAt)}`}</span>
      </span>
      <Icon name="chevronRight" size={14} />
    </button>
  );
}

export function NoteSheet() {
  useTick();
  const [o, setO] = useState<Open>(openState);
  const { branches, concepts, boards } = useStore();
  useEffect(() => {
    subs.add(setO);
    return () => void subs.delete(setO);
  }, []);
  useEffect(() => {
    if (!o) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setOpen(null);
      }
    };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [!!o]);
  if (!o) return null;

  const branch = 'branchId' in o ? branches[o.branchId] : undefined;
  const doc = 'conceptId' in o ? concepts.find((c) => c.id === o.conceptId) : undefined;
  const kept = branch ? concepts.find((c) => c.branchId === branch.id) : undefined;
  const note = branch?.note;
  const boardId = branch?.boardId ?? doc?.boardId ?? '';
  const boardName = boards.find((b) => b.id === boardId)?.name ?? doc?.boardName ?? '';
  const markdown = note?.markdown ?? doc?.markdown ?? '';
  const title = note?.title || doc?.title || 'Thread notes';
  if (!branch && !doc) return null;

  const openCode = (path: string, line?: number) => {
    setOpen(null);
    codeOpener(boardId, path, line);
  };

  return createPortal(
    <div className="note-sheet-bg" onClick={() => setOpen(null)}>
      <article className="note-sheet" onClick={(e) => e.stopPropagation()}>
        <header className="ns-head">
          <div className="ns-kicker">
            <Icon name={doc ? 'spark' : 'note'} size={13} /> {doc ? 'Concept' : 'Thread notes'}
            {boardName && <span>· {boardName}</span>}
          </div>
          <div className="ns-actions">
            {branch && (
              <button className="btn sm ghost" disabled={note?.busy} onClick={() => request({ type: 'refreshNote', branchId: branch.id }).catch((e: Error) => toast(e.message, 'error'))} title="Write the notes again from the whole thread">
                {note?.busy ? <span className="spinner" /> : <Icon name="refresh" size={13} />} {note?.busy ? 'Writing…' : 'Rewrite'}
              </button>
            )}
            {branch && markdown && (
              <button
                className={`btn sm ${kept ? 'ghost' : ''}`}
                onClick={() =>
                  request({ type: 'keepNote', branchId: branch.id }).then(
                    () => toast(kept ? 'Concepts copy updated' : 'Kept in Concepts. It stays in sync while the thread lives'),
                    (e: Error) => toast(e.message, 'error'),
                  )
                }
              >
                <Icon name={kept ? 'check' : 'bookmark'} size={13} /> {kept ? 'In Concepts' : 'Keep in Concepts'}
              </button>
            )}
            {markdown && (
              <button className="icon-btn sm" onClick={() => copy(markdown)} title="Copy as markdown" aria-label="Copy">
                <Icon name="copy" size={14} />
              </button>
            )}
            {doc && (
              <button
                className="icon-btn sm"
                title="Delete from Concepts"
                aria-label="Delete"
                onClick={() => {
                  if (!confirm('Delete this from Concepts?')) return;
                  request({ type: 'deleteConcept', id: doc.id }).catch(() => {});
                  setOpen(null);
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            )}
            <button className="icon-btn sm" onClick={() => setOpen(null)} aria-label="Close" title="Close (Esc)">
              <Icon name="x" size={15} />
            </button>
          </div>
        </header>
        <div className="ns-meta faint small">
          {note?.busy
            ? 'Updating with the latest step…'
            : note
              ? `${note.steps} step${note.steps === 1 ? '' : 's'} · updated ${timeAgo(note.updatedAt)}`
              : doc
                ? `${doc.steps} step${doc.steps === 1 ? '' : 's'} · kept ${timeAgo(doc.at)}${branches[doc.branchId] ? '' : ' · the thread was deleted'}`
                : ''}
          {note?.error && <span className="ns-error"> · Last update failed: {note.error}</span>}
        </div>
        <div className="ns-body">
          {markdown ? (
            <CodeRefCtx.Provider value={openCode}>
              <Md text={markdown.startsWith('# ') ? markdown : `# ${title}\n\n${markdown}`} />
            </CodeRefCtx.Provider>
          ) : (
            <div className="ns-empty">
              <span className="spinner" /> Writing the notes for this thread…
            </div>
          )}
        </div>
      </article>
    </div>,
    document.body,
  );
}
