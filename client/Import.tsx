import { useEffect, useState } from 'react';
import type { Board, ImportableSession } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { request, toast, useStore } from './store.ts';
import { Sheet, timeAgo } from './ui.tsx';

/** Bring existing Claude Code sessions (VS Code extension, CLI) for this folder onto the board. */
export function ImportSessions({ board, onClose, onDone }: { board: Board; onClose: () => void; onDone: (headId?: string) => void }) {
  const { nodes } = useStore();
  const [list, setList] = useState<ImportableSession[] | null>(null);
  const [err, setErr] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    request<ImportableSession[]>({ type: 'listSessions', boardId: board.id }).then(
      (l) => {
        setList(l);
        // Most recent new session preselected: the common case is "bring in what I was just doing".
        const first = l.find((s) => !s.imported);
        if (first) setPicked(new Set([first.sessionId]));
      },
      (e) => setErr(e.message),
    );
  }, [board.id]);

  const fresh = (list ?? []).filter((s) => !s.imported);
  const toggle = (id: string) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id])));

  const go = async () => {
    setBusy(true);
    try {
      // New threads go to the right of everything already on the board.
      const mine = Object.values(nodes).filter((n) => n.boardId === board.id);
      const x = mine.length ? Math.max(...mine.map((n) => n.position.x)) + 520 : 0;
      const y = mine.length ? Math.min(...mine.map((n) => n.position.y)) : 0;
      const res = await request<{ head: string; turns: number }[]>({ type: 'importSessions', boardId: board.id, sessionIds: [...picked], at: { x, y } });
      const turns = res.reduce((n, r) => n + r.turns, 0);
      toast(`Brought in ${res.length} session${res.length === 1 ? '' : 's'} (${turns} step${turns === 1 ? '' : 's'})`);
      onDone(res[0]?.head);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setBusy(false);
  };

  return (
    <Sheet title="Bring in Claude Code sessions" onClose={onClose}>
      <div className="form">
        <p className="faint import-intro">
          Sessions from the Claude Code extension or CLI in <span className="mono">{board.cwd.split('/').slice(-2).join('/')}</span>. Each prompt becomes a step you can
          continue or branch from.
        </p>
        {err && <div className="error-box">{err}</div>}
        {!list && !err && <div className="faint pad">Looking for sessions…</div>}
        {list && !list.length && (
          <div className="empty-note small">
            <Icon name="chat" size={22} />
            <div>No Claude Code sessions in this folder yet.</div>
          </div>
        )}
        {list && list.length > 0 && (
          <div className="import-list">
            {fresh.length > 1 && (
              <button className="link-btn import-all" onClick={() => setPicked(picked.size === fresh.length ? new Set() : new Set(fresh.map((s) => s.sessionId)))}>
                {picked.size === fresh.length ? 'Clear' : `Select all ${fresh.length}`}
              </button>
            )}
            {list.map((s) => (
              <button key={s.sessionId} className={`import-row ${picked.has(s.sessionId) ? 'on' : ''}`} disabled={s.imported} onClick={() => toggle(s.sessionId)}>
                <span className="check-box">{(picked.has(s.sessionId) || s.imported) && <Icon name="check" size={12} strokeWidth={2.5} />}</span>
                <span className="import-main">
                  <span className="import-title">{s.title}</span>
                  <span className="import-sub">
                    {timeAgo(s.lastModified)}
                    {s.gitBranch && <> · {s.gitBranch}</>}
                    {s.sizeKb != null && <> · {s.sizeKb < 1024 ? `${s.sizeKb} KB` : `${(s.sizeKb / 1024).toFixed(1)} MB`}</>}
                  </span>
                </span>
                {s.imported && <span className="pill">Added</span>}
              </button>
            ))}
          </div>
        )}
        <div className="form-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!picked.size || busy} onClick={go}>
            {busy ? 'Bringing in…' : picked.size > 1 ? `Bring in ${picked.size}` : 'Bring in'}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
