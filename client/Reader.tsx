import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CanvasNode, TurnNode } from '../shared/types.ts';
import { AsideList, SelectionAsk } from './Asides.tsx';
import { CardComments } from './Comments.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { parseDiff } from './Drawer.tsx';
import { Icon } from './icons.tsx';
import { DiffStat, LiveLine, Md, Permission, STATUS_LABEL, StatusDot, ToolLine, branchColor } from './nodes.tsx';
import { useReady } from './review.ts';
import { Attachments } from './Shots.tsx';
import { STAGE_LABEL, threadsOf, turnsOfBranch, type Stage, type ThreadRow } from './status.ts';
import { isLocalPage, openTerminalFor, request, toast, useStore } from './store.ts';
import { NoteBar, openThreadNote } from './ThreadNotes.tsx';
import { PrBadge, PrSection, StageChip, StageDot } from './Threads.tsx';
import { ToolDiff, editsOf } from './ToolDiff.tsx';
import { childrenOf, currentActivity, isLive, lastText, pathTo } from './tree.ts';
import { timeAgo, useTick } from './ui.tsx';
import { tipFrom } from './Workspace.tsx';

// The desktop's three panes: every thread on the left, the open one in the middle (a small map
// of its branches on top, its steps below), and what the chosen step changed on the right.

const typing = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey || !!(e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable], .cm-editor, .xterm');
const urgent = (s: Stage) => s === 'needs' || s === 'error' || s === 'failing' || s === 'feedback';
const busy = (s: Stage) => s === 'working' || s === 'checking';
const finished = (t: ThreadRow) => !!t.root.completed || t.stage === 'done' || t.stage === 'merged';

// ---------------- left: every thread ----------------

export function ThreadList({ boardId, current, onPick, onNew }: { boardId: string; current: TurnNode | null; onPick: (t: TurnNode) => void; onNew: () => void }) {
  useTick();
  const { nodes, branches, boards } = useStore();
  const ready = useReady();
  const threads = useMemo(() => threadsOf(nodes, branches, boards, ready, boardId), [nodes, branches, boards, ready, boardId]);
  const [q, setQ] = useState('');
  const [showDone, setShowDone] = useState(false);
  const root = current ? pathTo(nodes, current.id)[0] : null;
  const match = (t: ThreadRow) => !q.trim() || `${t.title} ${t.branches.map((b) => b.label).join(' ')}`.toLowerCase().includes(q.trim().toLowerCase());
  const shown = threads.filter(match);
  const groups: [string, ThreadRow[]][] = [
    ['Needs you', shown.filter((t) => !finished(t) && urgent(t.stage))],
    ['Working', shown.filter((t) => !finished(t) && busy(t.stage))],
    ['Open', shown.filter((t) => !finished(t) && !urgent(t.stage) && !busy(t.stage))],
    ['Done', shown.filter(finished)],
  ];
  // The order the arrow keys walk: what's on screen, top to bottom.
  const order = groups.flatMap(([label, list]) => (label === 'Done' && !showDone && !q ? [] : list));

  const pick = (t: ThreadRow) => onPick(tipFrom(nodes, t.root.id));
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e) || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      if (!order.length) return;
      e.preventDefault();
      const at = order.findIndex((t) => t.root.id === root?.id);
      const next = e.key === 'ArrowDown' ? order[Math.min(order.length - 1, at + 1)] : order[Math.max(0, at - 1)];
      if (next && next.root.id !== root?.id) pick(next);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });
  // Keep the open thread in view.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('.tl-row.on')?.scrollIntoView({ block: 'nearest' });
  }, [root?.id]);

  return (
    <aside className="tl">
      <div className="tl-head">
        <span className="tl-label">Threads</span>
        <span className="spacer" />
        <button className="tl-new" onClick={onNew} title="New thread (N)">
          <Icon name="plus" size={14} /> New
        </button>
      </div>
      <div className="tl-find">
        <Icon name="search" size={13} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter threads" onKeyDown={(e) => e.key === 'Escape' && (setQ(''), (e.target as HTMLInputElement).blur())} />
      </div>
      <div className="tl-scroll" ref={list}>
        {!threads.length && <div className="tl-empty">No threads yet. Start one with New.</div>}
        {groups.map(([label, rows]) => {
          if (!rows.length) return null;
          const folded = label === 'Done' && !showDone && !q;
          return (
            <section key={label} className="tl-group">
              <button className="tl-group-head" onClick={() => label === 'Done' && setShowDone(!showDone)} disabled={label !== 'Done'}>
                {label === 'Done' && <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={11} />}
                {label}
                <span>{rows.length}</span>
              </button>
              {!folded &&
                rows.map((t) => {
                  const on = t.root.id === root?.id;
                  const steps = t.branches.reduce((a, b) => a + b.steps, 0);
                  const pr = t.branches.find((b) => b.branch?.pr)?.branch?.pr;
                  return (
                    <div key={t.root.id} className={`tl-item ${on ? 'open' : ''}`}>
                      <button className={`tl-row ${on ? 'on' : ''}`} onClick={() => pick(t)} title={t.title}>
                        <StageDot stage={t.stage} />
                        <span className="tl-text">
                          <span className="tl-title">{t.title}</span>
                          <span className="tl-sub">{busy(t.stage) || urgent(t.stage) ? t.now || STAGE_LABEL[t.stage] : `${steps} step${steps === 1 ? '' : 's'}${t.branches.length > 1 ? ` · ${t.branches.length} branches` : ''}`}</span>
                        </span>
                        <span className="tl-when">{pr ? <PrBadge pr={pr} /> : timeAgo(t.at)}</span>
                      </button>
                      {on &&
                        t.branches.length > 1 &&
                        t.branches.map((b) => (
                          <button key={b.branchId} className={`tl-branch ${current?.branchId === b.branchId ? 'on' : ''}`} onClick={() => onPick(b.last)} style={{ ['--branch' as any]: branchColor(b.branchId) }} title={`${b.label} · ${STAGE_LABEL[b.stage]}`}>
                            <span className="tl-branch-line" />
                            <span className="ellipsis">{b.label}</span>
                            <StageDot stage={b.stage} />
                          </button>
                        ))}
                    </div>
                  );
                })}
            </section>
          );
        })}
      </div>
      <div className="tl-keys">
        <kbd>↑</kbd>
        <kbd>↓</kbd> threads <kbd>J</kbd>
        <kbd>K</kbd> steps
      </div>
    </aside>
  );
}

// ---------------- middle: the thread ----------------

/** A small map of one thread: a lane per branch, a dot per step. Click a dot to read it. */
export function BranchMap({ rootId, selectedId, onSelect }: { rootId: string; selectedId: string; onSelect: (id: string) => void }) {
  const { nodes } = useStore();
  const all: TurnNode[] = [];
  const walk = (t: TurnNode) => {
    all.push(t);
    childrenOf(nodes, t.id).forEach(walk);
  };
  const root = nodes[rootId] as TurnNode | undefined;
  if (!root) return null;
  walk(root);
  if (all.length < 2) return null;
  // Lanes: the thread's own line first, then branches in the order they were made.
  const lanes: string[] = [];
  for (const t of [...all].sort((a, b) => a.createdAt - b.createdAt)) if (!lanes.includes(t.branchId)) lanes.push(t.branchId);
  const depth = new Map<string, number>();
  for (const t of all) depth.set(t.id, t.parentId && depth.has(t.parentId) ? depth.get(t.parentId)! + 1 : 0);
  const onPath = new Set(pathTo(nodes, tipFrom(nodes, selectedId).id).map((t) => t.id));
  const X = 30;
  const Y = 22;
  const pos = (t: TurnNode) => ({ x: 14 + depth.get(t.id)! * X, y: 12 + lanes.indexOf(t.branchId) * Y });
  const maxD = Math.max(...all.map((t) => depth.get(t.id)!));
  const width = 14 + maxD * X + 14;
  const height = 12 + (lanes.length - 1) * Y + 12;
  const label = (branchId: string) => {
    const first = all.filter((t) => t.branchId === branchId).sort((a, b) => a.createdAt - b.createdAt)[0];
    return branchId === root.branchId ? 'main' : first?.title || first?.prompt || '';
  };
  return (
    <div className="bm">
      <svg width={width} height={height} className="bm-svg">
        {all.map((t) => {
          if (!t.parentId || !nodes[t.parentId]) return null;
          const a = pos(nodes[t.parentId] as TurnNode);
          const b = pos(t);
          const d = a.y === b.y ? `M${a.x} ${a.y} L${b.x} ${b.y}` : `M${a.x} ${a.y} C${a.x + X * 0.6} ${a.y} ${b.x - X * 0.6} ${b.y} ${b.x} ${b.y}`;
          return <path key={t.id} d={d} className={onPath.has(t.id) ? 'on' : ''} style={{ stroke: onPath.has(t.id) ? branchColor(t.branchId) : undefined }} />;
        })}
        {all.map((t) => {
          const p = pos(t);
          const on = t.id === selectedId;
          return (
            <g key={t.id} className={`bm-dot ${on ? 'sel' : ''} ${onPath.has(t.id) ? 'path' : ''} status-${t.status}`} onClick={() => onSelect(t.id)}>
              <title>{t.prompt}</title>
              <circle cx={p.x} cy={p.y} r={10} className="bm-hit" />
              {on && <circle cx={p.x} cy={p.y} r={8} className="bm-ring" />}
              <circle cx={p.x} cy={p.y} r={4.5} style={{ fill: branchColor(t.branchId) }} />
            </g>
          );
        })}
      </svg>
      <div className="bm-labels" style={{ height }}>
        {lanes.map((l, i) => (
          <button key={l} style={{ top: 12 + i * Y - 9, ['--branch' as any]: branchColor(l) }} onClick={() => onSelect(all.filter((t) => t.branchId === l).sort((a, b) => b.createdAt - a.createdAt)[0].id)} className={onPath.has(all.filter((t) => t.branchId === l).sort((a, b) => b.createdAt - a.createdAt)[0].id) ? 'on' : ''}>
            {label(l)}
          </button>
        ))}
      </div>
    </div>
  );
}

const took = (ms?: number) => (!ms ? '' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);

/** The open thread: its map, its steps (the chosen one open), and the box to reply or branch. */
export function ThreadReader({ stepId, onSelect, onBranch, composer, sideOpen, onToggleSide }: { stepId: string; onSelect: (id: string) => void; onBranch: (prompt: string) => void; composer: ReactNode; sideOpen: boolean; onToggleSide: () => void }) {
  useTick();
  const { nodes, branches, boards } = useStore();
  const ready = useReady();
  const step = nodes[stepId] as TurnNode;
  const path = pathTo(nodes, tipFrom(nodes, stepId).id);
  const root = path[0];
  const row = useMemo(() => threadsOf(nodes, branches, boards, ready, root.boardId).find((t) => t.root.id === root.id), [nodes, branches, boards, ready, root.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const index = path.findIndex((t) => t.id === stepId);

  // J / K walk the steps; the open one scrolls into view.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === 'j' && index < path.length - 1) onSelect(path[index + 1].id);
      else if (e.key === 'k' && index > 0) onSelect(path[index - 1].id);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });
  useEffect(() => {
    // Only when it's out of view: earlier steps stay on screen for context.
    (scroller.current?.querySelector('.rs.on') as HTMLElement | null)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [stepId]);

  const title = root.title || root.prompt;
  return (
    <section className="rd">
      <header className="rd-head">
        <div className="rd-title-row">
          <h1 className="rd-title" title={title}>
            {title}
          </h1>
          {row && <StageChip stage={row.stage} small />}
          <span className="spacer" />
          <button className={`icon-btn sm ${sideOpen ? 'on' : ''}`} onClick={onToggleSide} title={sideOpen ? 'Hide changes (])' : 'Show changes (])'} aria-label="Changes panel" aria-pressed={sideOpen}>
            <Icon name="sidebar" size={15} />
          </button>
        </div>
        <BranchMap rootId={root.id} selectedId={stepId} onSelect={onSelect} />
      </header>
      <div className="rd-scroll" ref={scroller}>
        <SelectionAsk scroller={scroller} node={step} onBranch={onBranch} />
        <div className="rd-note">
          <NoteBar branchId={step.branchId} />
        </div>
        <ol className="rd-steps">
          {path.map((s, i) => {
            const on = s.id === stepId;
            const others = childrenOf(nodes, s.id).filter((k) => !path.includes(k));
            return (
              <li key={s.id} className={`rs ${on ? 'on' : ''} status-${s.status}`} style={{ ['--branch' as any]: branchColor(s.branchId) }}>
                {on ? (
                  <StepBody node={s} n={i + 1} onBranch={onBranch} />
                ) : (
                  <button className="rs-row" onClick={() => onSelect(s.id)}>
                    <span className="rs-num">{i + 1}</span>
                    <span className="rs-text">
                      <span className="rs-prompt">{s.prompt}</span>
                      <span className="rs-sum">{isLive(s) ? currentActivity(s) : lastText(s) || s.error || STATUS_LABEL[s.status]}</span>
                    </span>
                    <span className="rs-meta">
                      <DiffStat s={s.diffStat} />
                      <StatusDot status={s.status} />
                    </span>
                  </button>
                )}
                {others.length > 0 && (
                  <div className="rs-forks">
                    {others.map((k) => (
                      <button key={k.id} onClick={() => onSelect(tipFrom(nodes, k.id).id)} style={{ ['--branch' as any]: branchColor(k.branchId) }} title={k.prompt}>
                        <Icon name="branch" size={11} />
                        <span className="ellipsis">{k.title || k.prompt}</span>
                      </button>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      {step.pending && (
        <div className="rd-ask">
          <Permission node={step} p={step.pending} />
        </div>
      )}
      <div className="rd-composer">{composer}</div>
    </section>
  );
}

/** One step, open: what you asked, the answer, side questions, and how it got there. */
function StepBody({ node, n, onBranch }: { node: TurnNode; n: number; onBranch: (prompt: string) => void }) {
  const { branches } = useStore();
  const branch = branches[node.branchId];
  const [long, setLong] = useState(false);
  const working = isLive(node);
  const final = [...node.events].reverse().find((e) => e.t === 'text' && e.text.trim());
  const tools = node.events.filter((e) => e.t === 'tool').length;
  return (
    <div className="rs-body">
      <div className="rs-top">
        <span className="rs-num">{n}</span>
        <StatusDot status={node.status} />
        {working ? <LiveLine node={node} /> : <b>{node.completed ? 'Completed' : STATUS_LABEL[node.status]}</b>}
        <span className="faint">
          {timeAgo(node.finishedAt ?? node.createdAt)}
          {node.durationMs ? ` · ${took(node.durationMs)}` : ''}
        </span>
      </div>
      <div className={`rs-ask ${long ? 'open' : ''}`} onClick={() => setLong(!long)}>
        {node.prompt}
      </div>
      <Attachments list={node.attachments} label={node.prompt} />
      {!!node.comments?.length && <CardComments node={node} roomy />}
      <div className="rs-answer">
        {final && final.t === 'text' ? <Md text={final.text} partial={working && final.partial} /> : <div className="ds-quiet">{working ? 'Working on it. The answer shows up here.' : 'The agent finished without a message.'}</div>}
        {node.error && <div className="error-box">{node.error}</div>}
      </div>
      <AsideList node={node} onBranch={onBranch} />
      {tools > 0 && (
        <details className="ds ds-fold">
          <summary>
            How it got there <span className="faint">· {tools} action{tools === 1 ? '' : 's'}</span>
          </summary>
          <div className="ds-steps">
            {node.events.map((e, i) =>
              e.t === 'text' ? (
                <Md key={i} text={e.text} />
              ) : e.t === 'thinking' ? (
                <details key={i} className="block">
                  <summary>Thinking</summary>
                  <div className="md faint">{e.text}</div>
                </details>
              ) : (
                <details key={i} className="block">
                  <summary>
                    <ToolLine e={e} cwd={branch?.cwd} />
                  </summary>
                  {editsOf(e) ? (
                    <ToolDiff e={e} cwd={branch?.cwd} />
                  ) : (
                    <pre className="pre">{JSON.stringify(e.input, null, 2)}</pre>
                  )}
                  {e.result != null && <pre className={`pre ${e.isError ? 'err' : ''}`}>{e.result}</pre>}
                </details>
              ),
            )}
          </div>
        </details>
      )}
    </div>
  );
}

// ---------------- right: what the step changed ----------------

export function ChangesPane({ node }: { node: TurnNode }) {
  const { branches, nodes } = useStore();
  const branch = branches[node.branchId];
  const [diff, setDiff] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    setDiff(null);
    request<string>({ type: 'diff', nodeId: node.id }).then(setDiff, () => setDiff(''));
  }, [node.id, node.commit]);
  const toolsDone = node.events.filter((e) => e.t === 'tool' && e.result != null).length;
  useEffect(() => {
    if (node.commit) return;
    const t = setTimeout(() => request<string>({ type: 'diff', nodeId: node.id }).then(setDiff, () => {}), 600);
    return () => clearTimeout(t);
  }, [toolsDone, node.status]);
  const files = parseDiff(diff ?? '');
  const working = isLive(node);
  const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => toast('Could not copy', 'error'));
  const cmd = node.sessionId && branch ? `cd ${JSON.stringify(branch.cwd)} && claude --resume ${node.sessionId} --fork-session` : '';
  const items: MenuItem[] = [
    ...(isLocalPage() ? [{ label: 'Open in editor', icon: 'code' as const, onClick: () => request<string>({ type: 'openEditor', nodeId: node.id }).then((app) => toast(`Opened in ${app}`), (e) => toast(e.message, 'error')) }] : []),
    ...(cmd ? [{ label: 'Copy resume command', icon: 'copy' as const, hint: 'Terminal', onClick: () => copy(cmd, 'Terminal command') }] : []),
    ...(branch?.gitBranch ? [{ label: 'Copy branch name', icon: 'branch' as const, onClick: () => copy(branch.gitBranch!, 'Branch name') }] : []),
    ...(branch ? [{ label: 'Copy folder path', icon: 'folder' as const, onClick: () => copy(branch.cwd, 'Folder path') }] : []),
    { label: 'Copy prompt', icon: 'copy', onClick: () => copy(node.prompt, 'Prompt') },
    ...(branch?.note?.markdown || branch?.note?.busy ? ['sep' as const, { label: 'Thread notes', icon: 'note' as const, onClick: () => openThreadNote(node.branchId) }] : []),
  ];
  const last = turnsOfBranch(nodes, node.branchId).slice(-1)[0] ?? node;
  return (
    <aside className="cp">
      <div className="cp-head">
        <span className="cp-label">Changes</span>
        {files.length > 0 && (
          <span className="cp-count">
            {files.length} file{files.length === 1 ? '' : 's'} <span className="add-text">+{files.reduce((a, f) => a + f.add, 0)}</span> <span className="del-text">−{files.reduce((a, f) => a + f.del, 0)}</span>
          </span>
        )}
        <span className="spacer" />
        <button className="icon-btn sm" onClick={() => openTerminalFor(node.branchId)} title="Terminal in this step's folder" aria-label="Terminal here">
          <Icon name="terminal" size={14} />
        </button>
        <button
          className="icon-btn sm"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 220, y: r.bottom + 6 });
          }}
          title="More"
          aria-label="More"
        >
          <Icon name="more" size={15} />
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      <div className="cp-scroll">
        {branch?.pr && <PrSection branch={branch} last={last} />}
        {!node.baseCommit ? (
          <div className="cp-quiet">{node.imported ? 'Made in Claude Code before it came here, so changes weren’t recorded.' : 'Changes show for projects in git.'}</div>
        ) : diff == null ? (
          <div className="cp-quiet">Loading…</div>
        ) : !files.length ? (
          <div className="cp-quiet">
            <Icon name="check" size={13} /> {working ? 'Nothing changed yet' : 'No files changed in this step.'}
          </div>
        ) : (
          <div className="cp-files">
            {files.map((f, i) => (
              <details key={f.path} className="cp-file" open={files.length <= 3 || i === 0}>
                <summary>
                  <Icon name="chevronRight" size={12} className="fr-caret" />
                  <span className="cp-name ellipsis" title={f.path}>
                    <b>{f.path.split('/').pop()}</b>
                    {f.path.includes('/') && <span className="faint"> {f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
                  </span>
                  {f.isNew && <span className="fr-tag">new</span>}
                  <span className="add-text">+{f.add}</span>
                  <span className="del-text">−{f.del}</span>
                </summary>
                <pre className="diff">
                  {f.lines.map((l, j) => (
                    <div key={j} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
                      {l || ' '}
                    </div>
                  ))}
                </pre>
              </details>
            ))}
          </div>
        )}
        {branch && !branch.pr && !working && <PrSection branch={branch} last={last} />}
        {working && <div className="cp-live">Updates as the agent edits.</div>}
      </div>
    </aside>
  );
}

/** The middle pane before any thread is open. */
export function NewThreadPane({ composer, count }: { composer: ReactNode; count: number }) {
  return (
    <section className="rd rd-new">
      <div className="rd-new-inner">
        <h1>What should an agent do?</h1>
        <p>{count ? 'Describe a task to start a new thread, or pick one on the left.' : 'Describe a task. Each one becomes a thread you can reply to and branch.'}</p>
        {composer}
      </div>
    </section>
  );
}

export type { CanvasNode };
