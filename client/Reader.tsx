import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CanvasNode, TurnNode } from '../shared/types.ts';
import { AsideList, SelectionAsk } from './Asides.tsx';
import { CardComments } from './Comments.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { parseDiff } from './Drawer.tsx';
import { Icon } from './icons.tsx';
import { DiffStat, LiveLine, Md, Permission, STATUS_LABEL, ToolLine, branchColor } from './nodes.tsx';
import { useReady } from './review.ts';
import { Attachments } from './Shots.tsx';
import { STAGE_LABEL, threadsOf, turnsOfBranch, type Stage, type ThreadRow } from './status.ts';
import { isLocalPage, openTerminalFor, request, toast, useStore } from './store.ts';
import { NoteBar, openThreadNote } from './ThreadNotes.tsx';
import { PrSection, StageChip } from './Threads.tsx';
import { ToolDiff, editsOf } from './ToolDiff.tsx';
import { childrenOf, isLive, lastText, pathTo } from './tree.ts';
import { timeAgo, useTick } from './ui.tsx';
import { tipFrom } from './Workspace.tsx';

// The desktop's three panes: every thread on the left; the open one in the middle, a map of its
// steps and branches on top and the steps themselves below, read like one document; and what the
// step you're reading changed on the right.

const typing = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey || !!(e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable], .cm-editor, .xterm');
const urgent = (s: Stage) => s === 'needs' || s === 'error' || s === 'failing' || s === 'feedback';
const busy = (s: Stage) => s === 'working' || s === 'checking';
const finished = (t: ThreadRow) => !!t.root.completed || t.stage === 'done' || t.stage === 'merged';

/** A step's map label: the written one, or the first few words of what was asked. */
export function stepLabel(t: TurnNode) {
  if (t.label) return t.label;
  const words = t.prompt
    .replace(/[`*_#>\[\]()]/g, '')
    .replace(/^(please|can you|could you|now|ok|okay|so|and)\b[\s,]*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 4)
    .join(' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Step';
}

/** Every step under a thread's first one. */
function threadSteps(nodes: Record<string, CanvasNode>, rootId: string) {
  const all: TurnNode[] = [];
  const walk = (t: TurnNode) => {
    all.push(t);
    childrenOf(nodes, t.id).forEach(walk);
  };
  const root = nodes[rootId] as TurnNode | undefined;
  if (root) walk(root);
  return all;
}

// ---------------- left: every thread ----------------

function ThreadIcon({ stage }: { stage: Stage }) {
  if (busy(stage)) return <span className="ti ti-work" title={STAGE_LABEL[stage]} />;
  if (stage === 'needs' || stage === 'feedback') return <span className="ti ti-needs" title={STAGE_LABEL[stage]} />;
  if (stage === 'error' || stage === 'failing') return <span className="ti ti-err" title={STAGE_LABEL[stage]} />;
  if (stage === 'done' || stage === 'merged')
    return (
      <span className="ti ti-done" title={STAGE_LABEL[stage]}>
        <Icon name="check" size={10} strokeWidth={3} />
      </span>
    );
  return <span className="ti ti-idle" title={STAGE_LABEL[stage]} />;
}

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
    ['Recent', shown.filter((t) => !finished(t) && !urgent(t.stage) && !busy(t.stage))],
    ['Done', shown.filter(finished)],
  ];
  const order = groups.flatMap(([label, list]) => (label === 'Done' && !showDone && !q ? [] : list));
  const pick = (t: ThreadRow) => onPick(tipFrom(nodes, t.root.id));
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e) || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') || !order.length) return;
      e.preventDefault();
      const at = order.findIndex((t) => t.root.id === root?.id);
      const next = e.key === 'ArrowDown' ? order[Math.min(order.length - 1, at + 1)] : order[Math.max(0, at - 1)];
      if (next && next.root.id !== root?.id) pick(next);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('.tl-row.on')?.scrollIntoView({ block: 'nearest' });
  }, [root?.id]);

  // The second line says the one thing worth knowing: what it's doing now, what it needs, or
  // the path it took (from the map's labels).
  const line = (t: ThreadRow) => {
    if (busy(t.stage) || urgent(t.stage)) return t.now || STAGE_LABEL[t.stage];
    const tip = tipFrom(nodes, t.root.id);
    const path = pathTo(nodes, tip.id);
    // The path it took, once the map has labels for it; until then, what it last said.
    if (path.length > 1 && path.every((s) => s.label)) {
      const labels = path.map((s) => s.label!);
      return labels.length > 3 ? `… → ${labels.slice(-3).join(' → ')}` : labels.join(' → ');
    }
    return lastText(tip) || tip.error || STATUS_LABEL[tip.status];
  };

  return (
    <aside className="tl">
      <div className="tl-head">
        <div className="tl-find">
          <Icon name="search" size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a thread" onKeyDown={(e) => e.key === 'Escape' && (setQ(''), (e.target as HTMLInputElement).blur())} />
        </div>
        <button className="tl-new" onClick={onNew} title="New thread" aria-label="New thread">
          <Icon name="plus" size={15} />
        </button>
      </div>
      <div className="tl-scroll" ref={list}>
        {!threads.length && <div className="tl-empty">No threads yet.</div>}
        {groups.map(([label, rows]) => {
          if (!rows.length) return null;
          const folded = label === 'Done' && !showDone && !q;
          return (
            <section key={label} className={`tl-group g-${label.split(' ')[0].toLowerCase()}`}>
              {label === 'Done' ? (
                <button className="tl-group-head" onClick={() => setShowDone(!showDone)}>
                  {label} <span>{rows.length}</span>
                  <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={11} />
                </button>
              ) : (
                <div className="tl-group-head">
                  {label} <span>{rows.length}</span>
                </div>
              )}
              {!folded &&
                rows.map((t) => {
                  const on = t.root.id === root?.id;
                  return (
                    <button key={t.root.id} className={`tl-row ${on ? 'on' : ''}`} onClick={() => pick(t)} title={t.title}>
                      <ThreadIcon stage={t.stage} />
                      <span className="tl-text">
                        <span className="tl-title">{t.title}</span>
                        <span className="tl-sub">{line(t)}</span>
                      </span>
                      <span className="tl-side">
                        <span className="tl-when">{timeAgo(t.at)}</span>
                        {t.branches.length > 1 && (
                          <span className="tl-forks" title={`${t.branches.length} branches`}>
                            <Icon name="branch" size={10} />
                            {t.branches.length}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

// ---------------- middle: the map ----------------

const GAP_X = 30;
const LANE = 62;
const STOP_H = 48;

const mapOpen = () => {
  try {
    return localStorage.getItem('forkspace:map') !== 'closed';
  } catch {
    return true;
  }
};

/**
 * The thread as a map: a lane per branch, a stop per step saying what happened there. A branch's
 * purpose sits in its lane, just before where it leaves. Click any stop to read it. Folds down to
 * a one-line trail when you want the room.
 */
export function ThreadMap({ rootId, selectedId, pathIds, onSelect }: { rootId: string; selectedId: string; pathIds: Set<string>; onSelect: (id: string) => void }) {
  const { nodes, branches } = useStore();
  const all = threadSteps(nodes, rootId);
  const root = nodes[rootId] as TurnNode | undefined;
  const [open, setOpen] = useState(mapOpen);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem('forkspace:map', open ? 'closed' : 'open');
    } catch {}
  };

  // Labels: asked for once per thread whenever a finished step or a branch doesn't have one yet.
  const missing = all.filter((t) => !t.label && !isLive(t)).length + new Set(all.map((t) => t.branchId)).size - new Set(all.filter((t) => branches[t.branchId]?.purpose).map((t) => t.branchId)).size;
  const asked = useRef('');
  useEffect(() => {
    const key = `${rootId}:${missing}`;
    if (!missing || asked.current === key) return;
    asked.current = key;
    request({ type: 'labelThread', rootId }).catch(() => {});
  }, [rootId, missing]);

  const box = useRef<HTMLDivElement>(null);
  // Stops share the room there is, so the whole thread usually fits.
  const [room, setRoom] = useState(700);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRoom(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);
  useEffect(() => {
    const el = box.current?.querySelector('.tm-stop.sel') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [selectedId, open]);

  if (!root) return null;
  const path = all.filter((t) => pathIds.has(t.id)).sort((a, b) => a.createdAt - b.createdAt);

  if (!open || all.length < 2)
    return (
      <div className="tm-trail">
        {(all.length < 2 ? all : path).map((t, i) => (
          <span key={t.id} className="tm-trail-item">
            {i > 0 && <Icon name="chevronRight" size={11} />}
            <button className={t.id === selectedId ? 'on' : ''} onClick={() => onSelect(t.id)} style={{ ['--branch' as any]: branchColor(t.branchId) }} title={t.prompt}>
              <span className={`tm-dot st-${t.status}`} />
              {stepLabel(t)}
            </button>
          </span>
        ))}
        {all.length >= 2 && (
          <button className="tm-fold" onClick={toggle} title="Show the map">
            <Icon name="chevronDown" size={13} /> Map
          </button>
        )}
      </div>
    );

  const lanes: string[] = [];
  for (const t of [...all].sort((a, b) => a.createdAt - b.createdAt)) if (!lanes.includes(t.branchId)) lanes.push(t.branchId);
  const depth = new Map<string, number>();
  for (const t of all) depth.set(t.id, t.parentId && depth.has(t.parentId) ? depth.get(t.parentId)! + 1 : 0);
  const maxD = Math.max(0, ...all.map((t) => depth.get(t.id)!));
  const PILL = Math.round(Math.max(130, Math.min(230, (room - maxD * GAP_X) / (maxD + 1))));
  const at = (t: TurnNode) => ({ x: depth.get(t.id)! * (PILL + GAP_X), y: lanes.indexOf(t.branchId) * LANE });
  const width = Math.max((maxD + 1) * (PILL + GAP_X) - GAP_X, room - 6);
  const height = (lanes.length - 1) * LANE + STOP_H;
  const firstOf = (id: string) => all.filter((t) => t.branchId === id).sort((a, b) => a.createdAt - b.createdAt)[0];
  const purpose = (id: string) => branches[id]?.purpose || (id === root.branchId ? 'Main line' : stepLabel(firstOf(id)));
  const took = (t: TurnNode) => (t.durationMs ? (t.durationMs < 60000 ? `${Math.round(t.durationMs / 1000)}s` : `${Math.round(t.durationMs / 60000)}m`) : '');

  return (
    <div className="tm">
      <div className="tm-scroll" ref={box}>
        <div className="tm-canvas" style={{ width, height }}>
          <svg width={width} height={height} className="tm-edges">
            {all.map((t) => {
              const parent = t.parentId ? (nodes[t.parentId] as TurnNode | undefined) : undefined;
              if (!parent) return null;
              const a = at(parent);
              const b = at(t);
              const on = pathIds.has(t.id);
              const style = on ? { stroke: branchColor(t.branchId) } : undefined;
              // Same lane: straight on. A new branch: down from under the stop it leaves, then along.
              if (a.y === b.y) return <path key={t.id} d={`M${a.x + PILL} ${a.y + STOP_H / 2} L${b.x} ${b.y + STOP_H / 2}`} className={on ? 'on' : ''} style={style} />;
              const x = a.x + PILL / 2;
              const y2 = b.y + STOP_H / 2;
              return <path key={t.id} d={`M${x} ${a.y + STOP_H} L${x} ${y2 - 10} Q${x} ${y2} ${x + 10} ${y2} L${b.x} ${y2}`} className={on ? 'on' : ''} style={style} />;
            })}
          </svg>
          {/* A branch's purpose, in the free room after its last stop (the main line's is the title). */}
          {lanes.map((l, i) => {
            if (l === root.branchId) return null;
            const last = all.filter((t) => t.branchId === l).sort((a, b) => depth.get(b.id)! - depth.get(a.id)!)[0];
            const first = firstOf(l);
            const after = at(last).x + PILL + 12;
            // No room after it: say it before the branch starts instead, on the empty part of its lane.
            const before = after > width - 110;
            const box = before ? { left: 0, width: at(first).x - 12, justifyContent: 'flex-end' as const } : { left: after, maxWidth: width - after };
            return (
              <div key={l} className={`tm-purpose ${before ? 'before' : ''} ${pathIds.has(first.id) ? 'on' : ''}`} style={{ ...box, top: i * LANE, height: STOP_H, ['--branch' as any]: branchColor(l) }} title={purpose(l)}>
                <Icon name="branch" size={11} />
                <span>{purpose(l)}</span>
              </div>
            );
          })}
          {all.map((t) => {
            const p = at(t);
            const on = pathIds.has(t.id);
            const live = isLive(t);
            const d = t.diffStat;
            return (
              <button
                key={t.id}
                className={`tm-stop ${t.id === selectedId ? 'sel' : ''} ${on ? 'path' : ''} st-${t.status}`}
                style={{ left: p.x, top: p.y, width: PILL, height: STOP_H, ['--branch' as any]: branchColor(t.branchId) }}
                onClick={() => onSelect(t.id)}
                title={`${t.prompt}\n${STATUS_LABEL[t.status]}`}
              >
                <span className="tm-label">{stepLabel(t)}</span>
                <span className="tm-meta">
                  <span className={`tm-dot st-${t.status}`} />
                  {live ? (
                    <span className="tm-live">{t.status === 'waiting' ? 'needs you' : 'working…'}</span>
                  ) : t.status === 'error' ? (
                    <span className="del-text">failed</span>
                  ) : d && d.files ? (
                    <>
                      <span className="add-text">+{d.insertions}</span>
                      <span className="del-text">−{d.deletions}</span>
                    </>
                  ) : (
                    <span>no changes</span>
                  )}
                  <span className="tm-took">{took(t)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <button className="tm-fold tm-fold-abs" onClick={toggle} title="Fold the map into one line">
        <Icon name="chevronUp" size={13} />
      </button>
    </div>
  );
}

// ---------------- middle: the thread, read like a document ----------------

const took = (ms?: number) => (!ms ? '' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);

export function ThreadReader({
  stepId,
  onSelect,
  composer,
  sideOpen,
  onToggleSide,
  onBranch,
}: {
  stepId: string;
  /** Start a branch from a step with this prompt (a side question turned into a branch). */
  onBranch: (fromId: string, prompt: string) => void;
  onSelect: (id: string) => void;
  /** The box under the thread: replies to `target` (the end of what you're reading, or a step you chose to branch from). */
  composer: (target: TurnNode, done: () => void) => ReactNode;
  sideOpen: boolean;
  onToggleSide: () => void;
}) {
  useTick();
  const { nodes, branches, boards } = useStore();
  const ready = useReady();
  const step = nodes[stepId] as TurnNode;

  // The path being read stays put while you scroll through it; it only changes when you pick a
  // step that isn't on it (another branch on the map, a new reply).
  const [tipId, setTipId] = useState(() => tipFrom(nodes, stepId).id);
  const tipOk = !!nodes[tipId] && pathTo(nodes, tipId).some((t) => t.id === stepId);
  const tip = tipOk ? tipFrom(nodes, tipId) : tipFrom(nodes, stepId);
  useEffect(() => {
    if (tip.id !== tipId) setTipId(tip.id);
  }, [tip.id]);
  const path = pathTo(nodes, tip.id);
  const pathIds = useMemo(() => new Set(path.map((t) => t.id)), [path.map((t) => t.id).join()]);
  const root = path[0];
  const row = useMemo(() => threadsOf(nodes, branches, boards, ready, root.boardId).find((t) => t.root.id === root.id), [nodes, branches, boards, ready, root.id]);

  // Branching from an earlier step: the box under the thread says so, until you send or cancel.
  const [branchFrom, setBranchFrom] = useState<string | null>(null);
  useEffect(() => setBranchFrom(null), [root.id]);
  const target = (branchFrom && (nodes[branchFrom] as TurnNode)) || tip;

  // Reading position. Scrolling picks the step you're on (the map and the changes follow);
  // picking a step on the map or with J/K scrolls to it.
  const scroller = useRef<HTMLDivElement>(null);
  const quiet = useRef(false);
  const until = useRef(0);
  const select = (id: string, scroll = true) => {
    quiet.current = !scroll;
    onSelect(id);
  };
  useLayoutEffect(() => {
    if (quiet.current) return void (quiet.current = false);
    const el = scroller.current?.querySelector(`[data-step="${stepId}"]`) as HTMLElement | null;
    if (!el || !scroller.current) return;
    until.current = Date.now() + 700;
    scroller.current.scrollTo({ top: Math.max(0, el.offsetTop - 16), behavior: 'smooth' });
  }, [stepId]);
  const onScroll = () => {
    const sc = scroller.current;
    if (!sc || Date.now() < until.current) return;
    const secs = [...sc.querySelectorAll<HTMLElement>('[data-step]')];
    const line = sc.scrollTop + sc.clientHeight * 0.3;
    let cur = secs[0];
    for (const s of secs) if (s.offsetTop <= line) cur = s;
    if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) cur = secs[secs.length - 1];
    const id = cur?.dataset.step;
    if (id && id !== stepId) select(id, false);
  };
  // While the last step streams, stay at the bottom if you were already there.
  const live = path.find(isLive);
  const streamed = live ? live.events.length + (live.events.at(-1)?.t === 'text' ? (live.events.at(-1) as any).text.length : 0) : 0;
  useEffect(() => {
    const sc = scroller.current;
    if (sc && live && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140) sc.scrollTop = sc.scrollHeight;
  }, [streamed]);

  const index = path.findIndex((t) => t.id === stepId);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === 'j' && index < path.length - 1) select(path[index + 1].id);
      else if (e.key === 'k' && index > 0) select(path[index - 1].id);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });

  const title = root.title || root.prompt;
  return (
    <section className="rd">
      <header className="rd-head">
        <div className="rd-title-row">
          <h1 className="rd-title" title={title}>
            {title}
          </h1>
          {row && <StageChip stage={row.stage} small />}
          <span className="rd-count">
            {path.length} step{path.length === 1 ? '' : 's'}
            {row && row.branches.length > 1 ? ` · ${row.branches.length} branches` : ''}
          </span>
          <span className="spacer" />
          <button className={`icon-btn sm ${sideOpen ? 'on' : ''}`} onClick={onToggleSide} title={sideOpen ? 'Hide changes (])' : 'Show changes (])'} aria-label="Changes panel" aria-pressed={sideOpen}>
            <Icon name="sidebar" size={15} />
          </button>
        </div>
        <ThreadMap rootId={root.id} selectedId={stepId} pathIds={pathIds} onSelect={(id) => select(id)} />
      </header>
      <div className="rd-scroll" ref={scroller} onScroll={onScroll}>
        <SelectionAsk scroller={scroller} node={step} onBranch={(p) => onBranch(step.id, p)} />
        <div className="rd-doc">
          <div className="rd-note">
            <NoteBar branchId={step.branchId} />
          </div>
          {path.map((s, i) => (
            <StepSection
              key={s.id}
              node={s}
              n={i + 1}
              on={s.id === stepId}
              last={i === path.length - 1}
              others={childrenOf(nodes, s.id).filter((k) => !pathIds.has(k.id))}
              onPoint={() => s.id !== stepId && select(s.id, false)}
              onBranchHere={() => (setBranchFrom(s.id), select(s.id, false))}
              onGo={(id) => select(tipFrom(nodes, id).id)}
              onBranch={(p) => onBranch(s.id, p)}
            />
          ))}
          <div className="rd-end" />
        </div>
      </div>
      <div className="rd-composer">
        {branchFrom && target.id !== tip.id && (
          <div className="rd-branching" style={{ ['--branch' as any]: branchColor(target.branchId) }}>
            <Icon name="branch" size={12} />
            Branching from step {path.findIndex((t) => t.id === target.id) + 1}: <b>{stepLabel(target)}</b>
            <span className="spacer" />
            <button onClick={() => setBranchFrom(null)}>Cancel</button>
          </div>
        )}
        {composer(target, () => setBranchFrom(null))}
      </div>
    </section>
  );
}

function StepSection({ node, n, on, last, others, onPoint, onBranchHere, onGo, onBranch }: { node: TurnNode; n: number; on: boolean; last: boolean; others: TurnNode[]; onPoint: () => void; onBranchHere: () => void; onGo: (id: string) => void; onBranch: (prompt: string) => void }) {
  const { branches } = useStore();
  const branch = branches[node.branchId];
  const [long, setLong] = useState(false);
  const working = isLive(node);
  const final = [...node.events].reverse().find((e) => e.t === 'text' && e.text.trim());
  const tools = node.events.filter((e) => e.t === 'tool').length;
  return (
    <article className={`ss ${on ? 'on' : ''} ${last ? 'last' : ''} st-${node.status}`} data-step={node.id} onPointerDown={onPoint} style={{ ['--branch' as any]: branchColor(node.branchId) }}>
      <div className="ss-rail">
        <span className="ss-num">{n}</span>
        <span className="ss-line" />
      </div>
      <div className="ss-main">
        <div className="ss-head">
          <span className="ss-label">{stepLabel(node)}</span>
          <span className="ss-meta">
            {working ? <LiveLine node={node} /> : <span className={`ss-status s-${node.status}`}>{node.completed ? 'Completed' : STATUS_LABEL[node.status]}</span>}
            <span>{timeAgo(node.finishedAt ?? node.createdAt)}</span>
            {node.durationMs ? <span>{took(node.durationMs)}</span> : null}
            <DiffStat s={node.diffStat} />
          </span>
          {!working && node.sessionId && !last && (
            <button className="ss-branch" onClick={onBranchHere} title="Try something else from this step">
              <Icon name="branch" size={12} /> Branch from here
            </button>
          )}
        </div>
        <div className={`ss-you ${long ? 'open' : ''}`} onClick={() => setLong(!long)}>
          <span className="ss-you-tag">You</span>
          <span className="ss-you-text">{node.prompt}</span>
        </div>
        <Attachments list={node.attachments} label={node.prompt} />
        {!!node.comments?.length && <CardComments node={node} roomy />}
        <div className="ss-answer">
          {final && final.t === 'text' ? <Md text={final.text} partial={working && final.partial} /> : <div className="ss-quiet">{working ? 'Working on it…' : 'Finished without a message.'}</div>}
          {node.error && <div className="error-box">{node.error}</div>}
        </div>
        {node.pending && (
          <div className="ss-pending">
            <Permission node={node} p={node.pending} />
          </div>
        )}
        <AsideList node={node} onBranch={onBranch} />
        {tools > 0 && (
          <details className="ss-how">
            <summary>
              <Icon name="chevronRight" size={12} className="fr-caret" />
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
                    {editsOf(e) ? <ToolDiff e={e} cwd={branch?.cwd} /> : <pre className="pre">{JSON.stringify(e.input, null, 2)}</pre>}
                    {e.result != null && <pre className={`pre ${e.isError ? 'err' : ''}`}>{e.result}</pre>}
                  </details>
                ),
              )}
            </div>
          </details>
        )}
        {others.length > 0 && (
          <div className="ss-forks">
            <span>Branched here</span>
            {others.map((k) => (
              <button key={k.id} onClick={() => onGo(k.id)} style={{ ['--branch' as any]: branchColor(k.branchId) }} title={k.prompt}>
                <span className="ss-fork-dot" />
                <span className="ellipsis">{branches[k.branchId]?.purpose || stepLabel(k)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
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

