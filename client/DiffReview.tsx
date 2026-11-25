import { Fragment, useState } from 'react';
import type { CardComment, TurnNode } from '../shared/types.ts';
import { CommentBox, CommentItem, save, uid } from './Comments.tsx';
import { Icon } from './icons.tsx';

// A changed file's diff you can comment on, like a code review: hover a line for +, or comment on
// the whole file from its header. Comments live on the step, show under their line, and go to the
// agent only when you send them.

type File = { path: string; add: number; del: number; isNew: boolean; lines: string[] };

/** Each diff line with its number in the new version (none for removed lines). */
function numbered(lines: string[]) {
  let n = 0;
  return lines.map((l) => {
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) {
      n = Number(h[1]);
      return { l, kind: 'hunk' as const };
    }
    if (l.startsWith('-')) return { l, kind: 'del' as const };
    const line = n++;
    return { l, kind: l.startsWith('+') ? ('add' as const) : ('same' as const), line };
  });
}

export function DiffFile({ node, f, open }: { node: TurnNode; f: File; open: boolean }) {
  const [at, setAt] = useState<number | 'file' | null>(null);
  const mine = (node.comments ?? []).filter((c) => c.path === f.path);
  const rows = numbered(f.lines);
  const add = (row: number | 'file', text: string | null) => {
    setAt(null);
    if (!text?.trim()) return;
    const r = row === 'file' ? null : rows[row];
    const c: CardComment = { id: uid(), text: text.trim(), at: Date.now(), path: f.path, ...(r && 'line' in r && r.line ? { line: r.line } : {}), ...(r ? { code: r.l.slice(1).trim().slice(0, 300) } : {}) };
    save(node, [...(node.comments ?? []), c]);
  };
  // Comments under the line they belong to: by line number, or by text for a removed line.
  const under = (i: number) => {
    const r = rows[i];
    if (r.kind === 'hunk') return [];
    return mine.filter((c) => ('line' in r && r.line ? c.line === r.line : !c.line && c.code === r.l.slice(1).trim().slice(0, 300)));
  };
  const fileLevel = mine.filter((c) => !c.line && !c.code);
  return (
    <details className="cp-file" data-path={f.path} open={open}>
      <summary>
        <Icon name="chevronRight" size={12} className="fr-caret" />
        <span className="cp-name ellipsis" title={f.path}>
          <b>{f.path.split('/').pop()}</b>
          {f.path.includes('/') && <span className="faint"> {f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
        </span>
        {f.isNew && <span className="fr-tag">new</span>}
        {mine.filter((c) => !c.done).length > 0 && (
          <span className="cp-ccount" title="Your comments on this file">
            <Icon name="comment" size={11} /> {mine.filter((c) => !c.done).length}
          </span>
        )}
        <span className="add-text">+{f.add}</span>
        <span className="del-text">−{f.del}</span>
        <button
          className="cp-fcomment"
          title="Comment on this file"
          aria-label="Comment on this file"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget.closest('details') as HTMLDetailsElement).open = true;
            setAt('file');
          }}
        >
          <Icon name="comment" size={12} />
        </button>
      </summary>
      {(fileLevel.length > 0 || at === 'file') && (
        <div className="dr-thread file">
          {fileLevel.map((c) => (
            <CommentItem key={c.id} node={node} c={c} />
          ))}
          {at === 'file' && <CommentBox initial="" onDone={(t) => add('file', t)} placeholder="About this file… (Enter to save)" />}
        </div>
      )}
      <div className="dr">
        {rows.map((r, i) => {
          const list = under(i);
          return (
            <Fragment key={i}>
              <div className={`dr-line ${r.kind}`}>
                <span className="dr-n">{'line' in r ? r.line : ''}</span>
                {r.kind !== 'hunk' && (
                  <button className="dr-plus" onClick={() => setAt(i)} title="Comment on this line" aria-label="Comment on this line">
                    <Icon name="plus" size={10} />
                  </button>
                )}
                <span className="dr-code">{r.l || ' '}</span>
              </div>
              {(list.length > 0 || at === i) && (
                <div className="dr-thread">
                  {list.map((c) => (
                    <CommentItem key={c.id} node={node} c={c} />
                  ))}
                  {at === i && <CommentBox initial="" onDone={(t) => add(i, t)} placeholder="Comment on this line… (Enter to save)" />}
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
    </details>
  );
}
