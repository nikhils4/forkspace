import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { Board, ChangedFile, FileResult, FilesResult, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { Permission, STATUS_LABEL, StatusDot, branchColor } from './nodes.tsx';
import { request, toast, useStore } from './store.ts';
import { isLive, leaves, pathTo, turnsOf } from './tree.ts';
import { Segmented, Switch, useIsMobile } from './ui.tsx';

const CodeEditor = lazy(() => import('./CodeEditor.tsx'));

/** Last file list per branch, for the command palette. */
export const fileCache = new Map<string, string[]>();

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const STATUS_NAME: Record<string, string> = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', T: 'Type changed', U: 'Conflict', C: 'Copied' };

function relTo(cwd: string | undefined, p: unknown): string | null {
  if (!cwd || typeof p !== 'string') return null;
  if (p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  if (!p.startsWith('/')) return p;
  return null;
}

const EXT_COLORS: Record<string, string> = {
  ts: '#5b9cf5', tsx: '#5b9cf5', js: '#e8c547', jsx: '#e8c547', mjs: '#e8c547', json: '#e8a047', css: '#b18cff', scss: '#f472b6',
  html: '#ff7a5c', md: '#8b9cff', py: '#4fb3d9', rs: '#f08a5d', go: '#2dd4e6', yml: '#ff7a85', yaml: '#ff7a85', sql: '#e8c547', sh: '#3ecf8e',
};
const extColor = (_p: string) => 'color-mix(in srgb, var(--text-3) 70%, transparent)';
void EXT_COLORS;

// ---------------- tree ----------------

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: string[];
}

function buildTree(files: string[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/');
      if (!cur.dirs.has(parts[i])) cur.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [] });
      cur = cur.dirs.get(parts[i])!;
    }
    cur.files.push(f);
  }
  return root;
}

function TreeDir({
  dir,
  depth,
  open,
  toggle,
  onOpen,
  current,
  changed,
  changedDirs,
}: {
  dir: Dir;
  depth: number;
  open: Set<string>;
  toggle: (p: string) => void;
  onOpen: (p: string) => void;
  current: string | null;
  changed: Map<string, ChangedFile>;
  changedDirs: Set<string>;
}) {
  const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...dir.files].sort((a, b) => a.localeCompare(b));
  return (
    <>
      {dirs.map((d) => {
        const isOpen = open.has(d.path);
        return (
          <div key={d.path}>
            <button className="tree-row" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(d.path)} title={d.path}>
              <Icon name="chevronRight" size={13} className={`tree-chev ${isOpen ? 'open' : ''}`} />
              <Icon name="folder" size={14} className="tree-folder" />
              <span className="ellipsis">{d.name}</span>
              {changedDirs.has(d.path) && <span className="tree-dot" />}
            </button>
            {isOpen && <TreeDir dir={d} depth={depth + 1} open={open} toggle={toggle} onOpen={onOpen} current={current} changed={changed} changedDirs={changedDirs} />}
          </div>
        );
      })}
      {files.map((f) => {
        const c = changed.get(f);
        return (
          <button key={f} className={`tree-row file ${current === f ? 'on' : ''} ${c ? `st-${c.status}` : ''}`} style={{ paddingLeft: 8 + depth * 14 + 17 }} onClick={() => onOpen(f)} title={f}>
            <span className="file-dot" style={{ background: extColor(f) }} />
            <span className="ellipsis">{f.split('/').pop()}</span>
            {c && <span className="st-letter">{c.status}</span>}
          </button>
        );
      })}
    </>
  );
}

function fuzzy(q: string, s: string) {
  q = q.toLowerCase();
  s = s.toLowerCase();
  if (s.includes(q)) return 1000 - s.length + (s.split('/').pop()!.includes(q) ? 500 : 0);
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length ? 100 - s.length / 10 : -1;
}

function ChangeRow({ c, on, onOpen }: { c: ChangedFile; on: boolean; onOpen: () => void }) {
  const name = c.path.split('/').pop();
  const dir = c.path.slice(0, c.path.length - (name?.length ?? 0));
  return (
    <button className={`change-row ${on ? 'on' : ''} st-${c.status}`} onClick={onOpen} title={`${STATUS_NAME[c.status] ?? c.status}: ${c.path}`}>
      <span className="st-letter">{c.status}</span>
      <span className="change-name ellipsis">
        <b>{name}</b> <span className="faint">{dir}</span>
      </span>
      <span className="change-stat">
        {c.add > 0 && <span className="add">+{c.add}</span>}
        {c.del > 0 && <span className="del">−{c.del}</span>}
      </span>
    </button>
  );
}

// ---------------- view ----------------

export function CodeView({
  board,
  target,
  setTargetId,
  openRequest,
}: {
  board: Board;
  target?: TurnNode;
  setTargetId: (id: string | null) => void;
  openRequest: { path: string; line?: number; n: number } | null;
}) {
  const { nodes, branches } = useStore();
  const mobile = useIsMobile();
  const tips = useMemo(() => leaves(nodes, board.id), [nodes, board.id]);
  const focusTurn = target ?? tips[0];
  // No thread yet: show the project's own folder (opening a file from the Map, say).
  const branchId = focusTurn?.branchId ?? `main:${board.id}`;
  const branch = focusTurn ? branches[branchId] : undefined;

  const [files, setFiles] = useState<FilesResult | null>(null);
  const [loadErr, setLoadErr] = useState('');
  const [tab, setTabState] = useState<'files' | 'changes'>('changes');
  const userTab = useRef(false);
  const setTab = (v: 'files' | 'changes') => {
    userTab.current = true;
    setTabState(v);
  };
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [file, setFile] = useState<FileResult | null>(null);
  const [showDiff, setShowDiff] = useState(true);
  const [follow, setFollow] = useState(true);
  const [pickBranch, setPickBranch] = useState(false);
  const [jump, setJump] = useState<{ path: string; line: number; n: number } | null>(null);

  const branchTurns = useMemo(() => turnsOf(nodes, board.id).filter((t) => t.branchId === branchId), [nodes, board.id, branchId]);
  const liveTurn = branchTurns.find(isLive);
  // Changes whenever an agent on this branch does something.
  const sig = branchTurns.map((t) => `${t.id}:${t.status}:${t.events.length}:${t.events.filter((e) => e.t === 'tool' && e.result != null).length}`).join('|');

  // File list (refreshes while agents work).
  useEffect(() => {
    if (!branchId) return;
    const t = setTimeout(() => {
      request<FilesResult>({ type: 'files', branchId }).then(
        (r) => {
          setFiles(r);
          setLoadErr('');
          fileCache.set(branchId, r.files);
        },
        (e) => setLoadErr(e.message),
      );
    }, files ? 500 : 0);
    return () => clearTimeout(t);
  }, [branchId, sig]);

  // New branch: reset the view.
  useEffect(() => {
    setFiles(null);
    setFile(null);
    setCurrent(null);
  }, [branchId]);

  // Expand folders that contain changes.
  const changed = useMemo(() => new Map((files?.changed ?? []).map((c) => [c.path, c])), [files]);
  const changedDirs = useMemo(() => {
    const s = new Set<string>();
    for (const p of changed.keys()) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join('/'));
    }
    return s;
  }, [changed]);
  useEffect(() => setOpen((o) => new Set([...o, ...changedDirs])), [changedDirs]);
  // Until you pick a tab yourself: show changes when there are some, the tree otherwise.
  useEffect(() => {
    if (files && !userTab.current) setTabState(files.changed.length ? 'changes' : 'files');
  }, [files?.changed.length]);

  // Open + refresh the current file.
  const load = (p: string) => {
    if (!branchId) return;
    request<FileResult>({ type: 'readFile', branchId, path: p }).then(
      (r) => {
        setFile(r);
        setCurrent(p);
      },
      (e) => toast(e.message, 'error'),
    );
  };
  const openFile = (p: string) => {
    if (p !== current) setShowDiff(true);
    setCurrent(p);
    load(p);
    const parts = p.split('/');
    setOpen((o) => new Set([...o, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))]));
  };
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => load(current), 400);
    return () => clearTimeout(t);
  }, [sig]);

  // Requests from the command palette or a step's file chip.
  useEffect(() => {
    if (!openRequest) return;
    openFile(openRequest.path);
    setJump(openRequest.line ? { path: openRequest.path, line: openRequest.line, n: openRequest.n } : null);
  }, [openRequest?.n]);

  // Follow the agent: open each file as it gets edited.
  const lastEdit = useMemo(() => {
    if (!liveTurn) return null;
    for (let i = liveTurn.events.length - 1; i >= 0; i--) {
      const e = liveTurn.events[i];
      if (e.t === 'tool' && EDIT_TOOLS.has(e.name)) {
        const rel = relTo(branch?.cwd, (e.input as any)?.file_path ?? (e.input as any)?.notebook_path);
        if (rel) return { id: e.id, rel };
      }
    }
    return null;
  }, [liveTurn, branch?.cwd]);
  useEffect(() => {
    if (follow && lastEdit) openFile(lastEdit.rel);
  }, [lastEdit?.id, follow]);

  const tree = useMemo(() => buildTree(files?.files ?? []), [files]);
  const results = useMemo(() => {
    if (!filter.trim() || !files) return [];
    return files.files
      .map((f) => [f, fuzzy(filter.trim(), f)] as const)
      .filter(([, s]) => s >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([f]) => f);
  }, [filter, files]);

  const steps = focusTurn ? pathTo(nodes, focusTurn.id) : [];
  const currentChange = current ? changed.get(current) : undefined;
  const canDiff = !!file && file.base != null && file.base !== file.text;


  // ---- left pane ----
  const sidebar = (
    <div className="code-side">
      <div className="code-branch">
        <button className="branch-pick" style={{ ['--branch' as any]: branchColor(branchId) }} onClick={() => setPickBranch(!pickBranch)}>
          <span className="branch-swatch" />
          <span className="branch-pick-text">
            <span className="ellipsis">{focusTurn?.prompt ?? board.name}</span>
            <span className="faint mono small">{branch?.gitBranch ?? 'working folder'}</span>
          </span>
          <Icon name="chevronDown" size={14} />
        </button>
        {pickBranch && (
          <div className="branch-menu">
            {tips.map((t) => (
              <button
                key={t.id}
                className={`branch-menu-item ${t.branchId === branchId ? 'on' : ''}`}
                style={{ ['--branch' as any]: branchColor(t.branchId) }}
                onClick={() => {
                  setTargetId(t.id);
                  setPickBranch(false);
                }}
              >
                <span className="branch-swatch" />
                <span className="ellipsis">{t.prompt}</span>
                <StatusDot status={t.status} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="code-search">
        <Icon name="file" size={14} />
        <input value={filter} placeholder="Go to file…" onChange={(e) => setFilter(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </div>

      {!filter && (
        <div className="code-tabs">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'changes', label: <>Changes{files?.changed.length ? <span className="count">{files.changed.length}</span> : null}</> },
              { value: 'files', label: 'All files' },
            ]}
          />
        </div>
      )}

      <div className="code-list">
        {loadErr && <div className="error-box">{loadErr}</div>}
        {!files && !loadErr && <div className="faint pad">Loading files…</div>}
        {files &&
          (filter ? (
            results.length ? (
              results.map((f) => (
                <button key={f} className={`tree-row file flat ${current === f ? 'on' : ''}`} onClick={() => openFile(f)}>
                  <span className="file-dot" style={{ background: extColor(f) }} />
                  <span className="ellipsis">
                    <b>{f.split('/').pop()}</b> <span className="faint">{f.split('/').slice(0, -1).join('/')}</span>
                  </span>
                </button>
              ))
            ) : (
              <div className="faint pad">No files match</div>
            )
          ) : tab === 'changes' ? (
            files.changed.length ? (
              files.changed.map((c) => <ChangeRow key={c.path} c={c} on={current === c.path} onOpen={() => openFile(c.path)} />)
            ) : (
              <div className="faint pad">{files.git ? 'No changes on this branch yet.' : 'Change tracking needs a git repo.'}</div>
            )
          ) : (
            <TreeDir
              dir={tree}
              depth={0}
              open={open}
              toggle={(p) => setOpen((o) => (o.has(p) ? new Set([...o].filter((x) => x !== p)) : new Set([...o, p])))}
              onOpen={openFile}
              current={current}
              changed={changed}
              changedDirs={changedDirs}
            />
          ))}
        {files?.truncated && <div className="faint pad small">Showing the first 20,000 files.</div>}
      </div>
    </div>
  );

  // ---- editor ----
  const editor = (
    <div className="code-main">
      <div className="code-head">
        {mobile && current && (
          <button className="icon-btn" onClick={() => setCurrent(null)} aria-label="Back to files">
            <Icon name="chevronLeft" />
          </button>
        )}
        {current ? (
          <div className="crumbs ellipsis" title={current}>
            {current.split('/').map((part, i, all) => (
              <span key={i} className={i === all.length - 1 ? 'crumb-file' : 'crumb'}>
                {part}
                {i < all.length - 1 && <Icon name="chevronRight" size={11} />}
              </span>
            ))}
            {currentChange && <span className={`st-pill st-${currentChange.status}`}>{STATUS_NAME[currentChange.status]}</span>}
          </div>
        ) : (
          <div className="crumbs faint">No file open</div>
        )}
        <span className="spacer" />
        {canDiff && (
          <Segmented
            value={showDiff ? 'diff' : 'file'}
            onChange={(v) => setShowDiff(v === 'diff')}
            options={[
              { value: 'diff', label: 'Changes' },
              { value: 'file', label: 'File' },
            ]}
          />
        )}
        {liveTurn && (
          <label className="follow" title="Open each file as the agent edits it">
            <span className={`dot ${liveTurn.status}`} />
            {!mobile && 'Follow agent'}
            <Switch on={follow} onChange={setFollow} />
          </label>
        )}
      </div>
      {liveTurn?.pending && (
        <div className="code-perm">
          <Permission node={liveTurn} p={liveTurn.pending} />
        </div>
      )}
      <div className="code-body">
        {!current || !file ? (
          <div className="code-placeholder">
            <div className="hero-mark">
              <Icon name="code" size={24} />
            </div>
            <h3>{files?.changed.length ? `${files.changed.length} file${files.changed.length === 1 ? '' : 's'} changed on this branch` : 'Browse the code'}</h3>
            <p className="faint">
              Pick a file on the left. Changed files open as a diff against where this thread started{liveTurn ? ', and Follow agent opens each file the moment it is edited' : ''}.
            </p>
            {files && files.changed.length > 0 && (
              <div className="placeholder-changes">
                {files.changed.slice(0, 6).map((c) => (
                  <ChangeRow key={c.path} c={c} on={false} onOpen={() => openFile(c.path)} />
                ))}
              </div>
            )}
          </div>
        ) : file.binary ? (
          <div className="code-placeholder faint">Binary file, {Math.round((file.size ?? 0) / 1024)} KB</div>
        ) : file.tooLarge ? (
          <div className="code-placeholder faint">Too large to show ({Math.round((file.size ?? 0) / 1024)} KB)</div>
        ) : !file.exists ? (
          <div className="code-placeholder faint">This file was deleted on this branch.</div>
        ) : (
          <Suspense fallback={<div className="faint pad">Loading editor…</div>}>
            <CodeEditor path={current} text={file.text} base={file.base} diff={showDiff && canDiff} wrap={mobile} jump={jump && jump.path === current ? jump : null} />
          </Suspense>
        )}
      </div>
    </div>
  );

  // ---- steps rail (wide screens) ----
  const rail = (
    <div className="code-rail">
      <div className="list-title">Steps on this branch</div>
      {steps.map((s, i) => {
        const touched = [
          ...new Set(
            s.events.flatMap((e) => (e.t === 'tool' && EDIT_TOOLS.has(e.name) ? [relTo(branches[s.branchId]?.cwd, (e.input as any)?.file_path)] : [])).filter((x): x is string => !!x),
          ),
        ];
        return (
          <div key={s.id} className={`rail-step ${s.id === focusTurn?.id ? 'on' : ''}`} style={{ ['--branch' as any]: branchColor(s.branchId) }}>
            <div className="rail-head">
              <span className="rail-n">{i + 1}</span>
              <StatusDot status={s.status} />
              <span className="faint small">{STATUS_LABEL[s.status]}</span>
            </div>
            <div className="rail-prompt">{s.prompt}</div>
            {touched.length > 0 && (
              <div className="rail-files">
                {touched.map((f) => (
                  <button key={f} className={`rail-file ${current === f ? 'on' : ''}`} onClick={() => openFile(f)} title={f}>
                    <span className="file-dot" style={{ background: extColor(f) }} />
                    <span className="ellipsis">{f.split('/').pop()}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  if (mobile) return <div className="code-view mobile">{current ? editor : sidebar}</div>;

  return (
    <div className="code-view">
      {sidebar}
      {editor}
      {rail}
    </div>
  );
}
