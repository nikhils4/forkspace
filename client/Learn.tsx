import { useMemo, useState } from 'react';
import type { Branch, ConceptDoc, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { useStore } from './store.ts';
import { openConcept, openThreadNote } from './ThreadNotes.tsx';
import { timeAgo, useTick } from './ui.tsx';

// Concepts: the notes of your threads, kept. Each one says what a piece of work was for, what
// changed, how it works (with links to the code) and what was decided. A thread's note lands
// here when the thread is deleted, or when you keep it by hand.

/** The opening paragraph of a note (under its title), for the card. */
function gist(md: string) {
  const lines = md.split('\n').map((l) => l.trim());
  const start = lines.findIndex((l) => l && !l.startsWith('#'));
  if (start < 0) return '';
  const para: string[] = [];
  for (const l of lines.slice(start)) {
    if (!l || l.startsWith('#')) break;
    para.push(l);
  }
  return para.join(' ').replace(/[`*_]/g, '');
}
const sections = (md: string) => (md.match(/^##\s+.+$/gm) ?? []).map((h) => h.replace(/^##\s+/, ''));

export function LearnLibrary({ onOpen: _onOpen }: { onOpen?: (t: TurnNode) => void }) {
  useTick();
  const { concepts, branches, boards, nodes } = useStore();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const match = (title: string, md: string, board: string) => !needle || `${title} ${md} ${board}`.toLowerCase().includes(needle);
  const boardName = (id: string) => boards.find((b) => b.id === id)?.name ?? '';

  // Threads still going: their notes are being written, not kept yet.
  const live = useMemo(
    () =>
      Object.values(branches)
        .filter((b): b is Branch & { note: NonNullable<Branch['note']> } => !!b.note?.markdown && !concepts.some((c) => c.branchId === b.id))
        .filter((b) => Object.values(nodes).some((n) => n.kind === 'turn' && n.branchId === b.id))
        .sort((a, b) => b.note.updatedAt - a.note.updatedAt),
    [branches, concepts, nodes],
  );
  const kept = concepts.filter((c) => match(c.title, c.markdown, c.boardName));
  const going = live.filter((b) => match(b.note.title, b.note.markdown, boardName(b.boardId)));

  if (!concepts.length && !live.length)
    return (
      <div className="concepts-empty">
        <Icon name="note" size={28} />
        <h3>Your threads, explained</h3>
        <p>Every thread gets a note at its top that Claude keeps up to date: what it's for, what changed, how it works with links to the code, and what was decided.</p>
        <p className="faint">When you delete a thread, its note moves here. You can also keep one here any time from the note.</p>
      </div>
    );

  const Card = ({ title, md, board, meta, onClick, busy }: { title: string; md: string; board: string; meta: string; onClick: () => void; busy?: boolean }) => (
    <button className="cdoc-card" onClick={onClick}>
      <span className="cc-top">
        <span className="cc-board">{board}</span>
        {busy && <span className="spinner" />}
      </span>
      <b className="cc-title">{title}</b>
      <span className="cc-gist">{gist(md)}</span>
      <span className="cc-sections">
        {sections(md)
          .slice(0, 4)
          .map((s) => (
            <i key={s}>{s}</i>
          ))}
      </span>
      <span className="cc-meta faint">{meta}</span>
    </button>
  );

  return (
    <div className="concepts-lib">
      <div className="lib-head">
        <div className="lib-count">
          <b>{concepts.length}</b> kept{live.length ? ` · ${live.length} being written` : ''}
        </div>
        <div className="code-search lib-search">
          <Icon name="search" size={14} />
          <input value={q} placeholder="Search what you've built…" onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {going.length > 0 && (
        <section>
          <h3 className="cc-shelf">Threads going now</h3>
          <div className="cdoc-grid">
            {going.map((b) => (
              <Card key={b.id} title={b.note.title} md={b.note.markdown} board={boardName(b.boardId)} busy={b.note.busy} meta={`${b.note.steps} step${b.note.steps === 1 ? '' : 's'} · updated ${timeAgo(b.note.updatedAt)}`} onClick={() => openThreadNote(b.id)} />
            ))}
          </div>
        </section>
      )}
      {kept.length > 0 && (
        <section>
          <h3 className="cc-shelf">Kept</h3>
          <div className="cdoc-grid">
            {kept.map((c: ConceptDoc) => (
              <Card key={c.id} title={c.title} md={c.markdown} board={c.boardName} meta={`${c.steps} step${c.steps === 1 ? '' : 's'} · ${branches[c.branchId] ? 'thread still open' : 'thread deleted'} · ${timeAgo(c.at)}`} onClick={() => openConcept(c.id)} />
            ))}
          </div>
        </section>
      )}
      {!kept.length && !going.length && <div className="faint pad">Nothing matches.</div>}
    </div>
  );
}
