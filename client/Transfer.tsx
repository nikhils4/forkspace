import { useEffect, useRef, useState } from 'react';
import type { ImportPlan, ImportResult } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { getToken, toast } from './store.ts';

// Settings → Move to another Mac: export everything to one file, import it on the other side.

const auth = () => ({ authorization: `Bearer ${getToken() ?? ''}` });

async function api<T>(route: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api/workspace/${route}`, { ...init, headers: { ...auth(), ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Something went wrong.');
  return r.json();
}

const mb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function MoveSection() {
  const [exporting, setExporting] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [reading, setReading] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const exportAll = async () => {
    setExporting(true);
    try {
      const r = await fetch('/api/workspace/export', { headers: auth() });
      if (!r.ok) throw new Error('Export failed.');
      const blob = await r.blob();
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'forkspace.forkspace';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      toast(`Exported ${name} (${mb(blob.size)})`);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setExporting(false);
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setReading(true);
    try {
      setPlan(await api<ImportPlan>('import', { method: 'POST', body: f }));
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setReading(false);
    if (file.current) file.current.value = '';
  };

  return (
    <section className="card-section">
      <h3>
        <Icon name="download" size={16} /> Move to another Mac
      </h3>
      <p className="faint">
        One file with every board, step, note and concept, the conversations behind them, and each branch's code. Your access key and paired phones stay on this Mac.
      </p>
      <div className="move-actions">
        <button className="btn sm" onClick={exportAll} disabled={exporting}>
          {exporting ? <span className="spinner" /> : <Icon name="download" size={13} />} Export everything
        </button>
        <button className="btn sm" onClick={() => file.current?.click()} disabled={reading}>
          {reading ? <span className="spinner" /> : <Icon name="folder" size={13} />} Import a file
        </button>
        <input ref={file} type="file" accept=".forkspace,application/octet-stream" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {plan && <ImportPanel plan={plan} onDone={() => setPlan(null)} />}
    </section>
  );
}

function ImportPanel({ plan, onDone }: { plan: ImportPlan; onDone: () => void }) {
  const [folders, setFolders] = useState<Record<string, string>>(() => Object.fromEntries(plan.boards.map((b) => [b.id, b.suggested])));
  const [on, setOn] = useState<Record<string, boolean>>(() => Object.fromEntries(plan.boards.map((b) => [b.id, !b.already && b.found])));
  const [found, setFound] = useState<Record<string, boolean>>(() => Object.fromEntries(plan.boards.map((b) => [b.id, b.found])));
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);

  // Check each folder as it's typed.
  useEffect(() => {
    const t = setTimeout(() => {
      for (const b of plan.boards)
        api<{ exists: boolean }>(`folder?path=${encodeURIComponent(folders[b.id] ?? '')}`).then(
          (r) => setFound((f) => (f[b.id] === r.exists ? f : { ...f, [b.id]: r.exists })),
          () => {},
        );
    }, 250);
    return () => clearTimeout(t);
  }, [folders]);

  const chosen = plan.boards.filter((b) => on[b.id] && !b.already && found[b.id]);

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api<ImportResult[]>('apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: plan.id, folders: Object.fromEntries(chosen.map((b) => [b.id, folders[b.id]])) }),
      });
      setResults(r);
      const ok = r.filter((x) => x.ok).length;
      toast(ok ? `Imported ${ok} board${ok === 1 ? '' : 's'}` : 'Nothing was imported', ok ? 'info' : 'error');
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setBusy(false);
  };

  if (results)
    return (
      <div className="import-panel">
        {results.map((r, i) => (
          <div key={i} className={`import-result ${r.ok ? 'ok' : 'skip'}`}>
            <Icon name={r.ok ? 'check' : 'x'} size={14} />
            <div>
              <b>{r.name}</b>
              <span>{r.note}</span>
            </div>
          </div>
        ))}
        <button className="btn sm" onClick={onDone}>
          Done
        </button>
      </div>
    );

  return (
    <div className="import-panel">
      <div className="import-head">
        <b>From {new Date(plan.exportedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</b>
        <span className="faint">Check where each project lives on this Mac.</span>
      </div>
      {plan.boards.map((b) => (
        <div key={b.id} className={`import-board ${b.already ? 'already' : ''}`}>
          <label className="import-pick">
            <input type="checkbox" checked={!!on[b.id] && !b.already} disabled={b.already} onChange={(e) => setOn({ ...on, [b.id]: e.target.checked })} />
            <div>
              <b>{b.name}</b>
              <span className="faint small">
                {b.already ? 'Already on this Mac' : `${b.steps} step${b.steps === 1 ? '' : 's'}${b.notes ? ` · ${b.notes} note${b.notes === 1 ? '' : 's'}` : ''}${b.code ? ' · code branches' : ''}`}
              </span>
            </div>
          </label>
          {!b.already && (
            <div className="import-folder">
              <input
                className="mono"
                value={folders[b.id] ?? ''}
                spellCheck={false}
                autoCapitalize="off"
                onChange={(e) => {
                  setFolders({ ...folders, [b.id]: e.target.value });
                  setOn({ ...on, [b.id]: true });
                }}
                aria-label={`Folder for ${b.name}`}
              />
              <span className={`import-found ${found[b.id] ? 'yes' : 'no'}`}>{found[b.id] ? 'Found' : 'No folder here'}</span>
            </div>
          )}
          {!b.already && !found[b.id] && <span className="faint small">Clone or copy the project to this Mac first, then type where it is.</span>}
        </div>
      ))}
      <div className="import-actions">
        <button className="btn primary sm" onClick={apply} disabled={busy || !chosen.length}>
          {busy ? <span className="spinner light" /> : null} Import {chosen.length} board{chosen.length === 1 ? '' : 's'}
        </button>
        <button className="btn sm ghost" onClick={onDone} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
