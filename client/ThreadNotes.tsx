import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Branch, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { CodeRefCtx } from './Markdown.tsx';
import { Md } from './nodes.tsx';
import { request, toast, useStore } from './store.ts';
import { timeAgo, useTick } from './ui.tsx';
import { isTurn } from './tree.ts';

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

/**
 * A thread's one note, wherever you look from (any card or branch in it): the note lives on the
 * branch of the thread's first card and covers every branch. Also says how many finished steps
 * aren't in it yet.
 */
export function useThreadNote(branchId: string) {
  const { nodes, branches } = useStore();
  return useMemo(() => {
    const turns = Object.values(nodes).filter(isTurn);
    const byId = new Map(turns.map((t) => [t.id, t]));
    const first = turns.filter((t) => t.branchId === branchId).sort((a, b) => a.createdAt - b.createdAt)[0];
    let root = first;
    for (let p = root && byId.get(root.parentId ?? ''); p; p = byId.get(p.parentId ?? '')) root = p;
    const rootId = root?.branchId ?? branchId;
    // Every finished step under the thread's first card.
    const kids = new Map<string, string[]>();
    for (const t of turns) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t.id]);
    const done: string[] = [];
    const walk = (id: string) => {
      const t = byId.get(id);
      if (!t) return;
      if (t.status !== 'running' && t.status !== 'waiting') done.push(id);
      for (const k of kids.get(id) ?? []) walk(k);
    };
    if (root) walk(root.id);
    const branch = branches[rootId];
    const note = branch?.note;
    const behind = !note ? done.length : note.stepIds ? done.filter((id) => !note.stepIds!.includes(id)).length : Math.max(0, done.length - note.steps);
    return { rootId, branch, note, behind, total: done.length };
  }, [nodes, branches, branchId]);
}

const sync = (branchId: string, mode: 'sync' | 'rewrite') => request({ type: 'refreshNote', branchId, mode }).catch((e: Error) => toast(e.message, 'error'));

const copy = (text: string) =>
  navigator.clipboard.writeText(text).then(
    () => toast('Copied'),
    () => toast('Could not copy', 'error'),
  );

/** A note opens with "**Now:** …" and "**Next:** …": pulled out to show as a status block. */
export function splitStatus(md: string) {
  let now = '';
  let next = '';
  const rest = md
    .split('\n')
    .filter((l) => {
      const m = l.match(/^\s*\*\*(Now|Next):\*\*\s*(.+)$/i);
      if (!m) return true;
      if (m[1].toLowerCase() === 'now') now = m[2].trim();
      else next = m[2].trim();
      return false;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { now, next, rest };
}

/** The tab on a thread's first card. */
export function NoteTab({ branchId, inline }: { branchId: string; inline?: boolean }) {
  const { branch, note: n, behind } = useThreadNote(branchId);
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
      {!n.busy && behind > 0 && <em className="behind">{behind} new</em>}
      {!n.busy && n.error && !behind && <em className="behind err">failed</em>}
    </button>
  );
}

/** A thread's notes in a line, for the details panel and the chat. */
export function NoteBar({ branchId }: { branchId: string }) {
  useTick();
  const { rootId, note: n, behind } = useThreadNote(branchId);
  if (!n || (!n.markdown && !n.busy)) return null;
  const status = n.busy
    ? 'Updating with the latest steps…'
    : behind
      ? `${behind} new step${behind === 1 ? '' : 's'} not in the notes yet`
      : n.error
        ? `Last update failed`
        : `Up to date · ${n.steps} step${n.steps === 1 ? '' : 's'} · ${timeAgo(n.updatedAt)}`;
  return (
    <div className={`tnote-bar ${behind && !n.busy ? 'behind' : ''}`}>
      <button className="tnote-bar-main" onClick={() => openThreadNote(rootId)}>
        <span className="tnote-bar-icon">{n.busy ? <span className="spinner" /> : <Icon name="note" size={14} />}</span>
        <span className="tnote-bar-text">
          <b className="ellipsis">{n.markdown ? n.title : 'Writing thread notes…'}</b>
          <span className="faint">{status}</span>
        </span>
      </button>
      {!n.busy && (behind > 0 || n.error) ? (
        <button className="btn sm" onClick={() => sync(rootId, 'sync')} title="Fold the latest steps into the notes">
          <Icon name="refresh" size={12} /> Sync
        </button>
      ) : (
        <Icon name="chevronRight" size={14} />
      )}
    </div>
  );
}

export function NoteSheet() {
  useTick();
  const [o, setO] = useState<Open>(openState);
  const { branches, concepts, boards } = useStore();
  const thread = useThreadNote(o && 'branchId' in o ? o.branchId : '');
  // Opening notes that are behind brings them up to date on its own (once per open).
  const autoSynced = useRef<string | null>(null);
  useEffect(() => {
    if (!o || !('branchId' in o)) {
      autoSynced.current = null;
      return;
    }
    if (autoSynced.current === thread.rootId || thread.note?.busy || !thread.behind) return;
    autoSynced.current = thread.rootId;
    sync(thread.rootId, 'sync');
  }, [o, thread.rootId, thread.behind, thread.note?.busy]);
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

  const branch = 'branchId' in o ? thread.branch : undefined;
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
            {branch && (note?.busy || thread.behind > 0 || note?.error) && (
              <button className="btn sm primary" disabled={note?.busy} onClick={() => sync(branch.id, 'sync')} title="Fold the steps that aren't in the notes yet">
                {note?.busy ? <span className="spinner" /> : <Icon name="refresh" size={13} />} {note?.busy ? 'Syncing…' : thread.behind ? `Sync ${thread.behind} new` : 'Try again'}
              </button>
            )}
            {branch && !note?.busy && (
              <button className="btn sm ghost" onClick={() => sync(branch.id, 'rewrite')} title="Write the notes again from scratch, from every step in the thread">
                Rewrite
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
            ? 'Updating with the latest steps…'
            : note
              ? thread.behind
                ? `${thread.behind} of ${thread.total} steps aren't in the notes yet · updated ${timeAgo(note.updatedAt)}`
                : `Up to date with all ${thread.total} step${thread.total === 1 ? '' : 's'} · updated ${timeAgo(note.updatedAt)}`
              : doc
                ? `${doc.steps} step${doc.steps === 1 ? '' : 's'} · kept ${timeAgo(doc.at)}${branches[doc.branchId] ? '' : ' · the thread was deleted'}`
                : ''}
          {note?.error && <span className="ns-error"> · Last update failed: {note.error}</span>}
        </div>
        <div className="ns-body">
          {markdown ? (
            <CodeRefCtx.Provider value={openCode}>
              {(() => {
                const { now, next, rest } = splitStatus(markdown.startsWith('# ') ? markdown : `# ${title}\n\n${markdown}`);
                const h1 = rest.match(/^# .*\n?/)?.[0] ?? '';
                return (
                  <>
                    {h1 && <Md text={h1} />}
                    {(now || next) && (
                      <div className="ns-status">
                        {now && (
                          <div className="ns-st now">
                            <span>Now</span>
                            <Md text={now} />
                          </div>
                        )}
                        {next && (
                          <div className="ns-st next">
                            <span>Next</span>
                            <Md text={next} />
                          </div>
                        )}
                      </div>
                    )}
                    <Md text={rest.slice(h1.length)} />
                  </>
                );
              })()}
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
