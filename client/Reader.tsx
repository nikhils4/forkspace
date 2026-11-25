import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CanvasNode, TurnNode } from '../shared/types.ts';
import { AsideList, SelectionAsk } from './Asides.tsx';
import { CardComments } from './Comments.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { parseDiff } from './Drawer.tsx';
import { Icon } from './icons.tsx';
import { DiffStat, LiveLine, Md, Permission, STATUS_LABEL, ToolLine, branchColor } from './nodes.tsx';
import { useReady } from './review.ts';
import { TagChips, TagPicker, tagsOf } from './Tags.tsx';
import { TaskShell, useTaskRun } from './RunBox.tsx';
import { Attachments } from './Shots.tsx';
import { STAGE_LABEL, taskName, threadsOf, turnsOfBranch, type Stage, type ThreadRow } from './status.ts';
import { isLocalPage, openTerminalFor, request, send, toast, useStore } from './store.ts';
import { NoteButton, openThreadNote } from './ThreadNotes.tsx';
import { PrSection } from './Threads.tsx';
import { ToolDiff, editsOf } from './ToolDiff.tsx';
import { childrenOf, currentActivity, isLive, pathTo } from './tree.ts';
import { timeAgo, useTick } from './ui.tsx';
import { StatusIcon, statusKind, taskWord, tipFrom } from './Workspace.tsx';

// The desktop's three panes for the task in the open tab: its steps and branches on the left, one
// short line each; what happened at each step in the middle (what you asked, what it said, the
// commands it ran), with what to do next above the reply box; what the step changed on the right.

const typing = (e: KeyboardEvent) => e.metaKey || e.ctrlKey || e.altKey || !!(e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable], .cm-editor, .xterm');

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

// ---------------- left: the task's steps, one line each ----------------

const ROW = 34;
const laneX = (lane: number) => 13 + lane * 16;

/**
 * The task as a short vertical list: one dot and a few words per step, branches as side lanes
 * that leave from the step they grew from. Click a step to read it.
 */
export function StepTree({ rootId, selectedId, pathIds, onSelect }: { rootId: string; selectedId: string; pathIds: Set<string>; onSelect: (id: string) => void }) {
  const { nodes, branches } = useStore();
  const all = threadSteps(nodes, rootId);

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
  useEffect(() => {
    (box.current?.querySelector('.stp.sel') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const [menu, setMenu] = useState<{ x: number; y: number; t: TurnNode } | null>(null);
  const root = nodes[rootId] as TurnNode | undefined;
  if (!root) return <nav className="stree" />;
  const top = (root.startAt && (nodes[root.startAt] as TurnNode | undefined)) || root;
  const hidden = all.length - threadSteps(nodes, top.id).length;
  const startHere = (t: TurnNode) => {
    send({ type: 'setStart', rootId: root.id, stepId: t.id });
    if (!pathTo(nodes, selectedId).some((s) => s.id === t.id)) onSelect(t.id);
    toast('Earlier steps hidden. They’re not deleted, and Keep still includes their changes.');
  };
  const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => toast('Could not copy', 'error'));
  const menuFor = (t: TurnNode): MenuItem[] => {
    const said = [...t.events].reverse().find((e) => e.t === 'text' && e.text.trim());
    return [
      ...(t.id !== top.id ? [{ label: 'Start the tree here', icon: 'chevronUp' as const, hint: 'hides steps above', onClick: () => startHere(t) }] : []),
      ...(hidden ? [{ label: `Show all steps (${hidden} hidden)`, icon: 'chevronDown' as const, onClick: () => send({ type: 'setStart', rootId: root.id, stepId: null }) }] : []),
      'sep',
      { label: 'Copy what you asked', icon: 'copy', onClick: () => copy(t.prompt, 'Prompt') },
      ...(said && said.t === 'text' ? [{ label: 'Copy what it said', icon: 'copy' as const, onClick: () => copy(said.text, 'Answer') }] : []),
    ];
  };
  // Depth first, a step's own continuation before the branches that leave it.
  const rows: TurnNode[] = [];
  const walk = (t: TurnNode) => {
    rows.push(t);
    const kids = childrenOf(nodes, t.id).sort((a, b) => a.createdAt - b.createdAt);
    [...kids.filter((k) => k.branchId === t.branchId), ...kids.filter((k) => k.branchId !== t.branchId)].forEach(walk);
  };
  walk(top);
  const lanes: string[] = [];
  for (const t of rows) if (!lanes.includes(t.branchId)) lanes.push(t.branchId);
  const row = new Map(rows.map((t, i) => [t.id, i]));
  const lane = (t: TurnNode) => lanes.indexOf(t.branchId);
  const pad = laneX(lanes.length - 1) + 16;
  const height = rows.length * ROW;
  const purpose = (t: TurnNode) => branches[t.branchId]?.purpose;
  const dot = (t: TurnNode) => (t.status === 'running' ? 'run' : t.status === 'waiting' ? 'needs' : t.status === 'error' ? 'err' : t.completed ? 'kept' : '');

  return (
    <nav className="stree" aria-label="Steps">
      <div className="stree-task" title={root.prompt}>
        {root.title || stepLabel(root)}
      </div>
      <div className="stree-h">
        Steps <span>{rows.length}{lanes.length > 1 ? ` · ${lanes.length} branches` : ''}</span>
      </div>
      {hidden > 0 && (
        <button className="stree-hidden" onClick={() => send({ type: 'setStart', rootId: root.id, stepId: null })} title="Show the steps above again">
          <Icon name="chevronUp" size={12} />
          {hidden} earlier step{hidden === 1 ? '' : 's'} hidden
          <span>Show</span>
        </button>
      )}
      <div className="stree-scroll" ref={box}>
        <div className="stree-rows" style={{ height }}>
          <svg width="100%" height={height} className="stree-edges" aria-hidden>
            {rows.map((t) => {
              const p = t.parentId ? (nodes[t.parentId] as TurnNode | undefined) : undefined;
              if (!p || !row.has(p.id)) return null;
              const px = laneX(lane(p));
              const py = row.get(p.id)! * ROW + ROW / 2;
              const cx = laneX(lane(t));
              const cy = row.get(t.id)! * ROW + ROW / 2;
              const on = pathIds.has(t.id);
              const d = px === cx ? `M${px} ${py}V${cy}` : `M${px} ${py}C${px} ${py + 14} ${cx} ${py + 8} ${cx} ${py + 24}V${cy}`;
              return <path key={t.id} d={d} className={on ? 'on' : ''} style={on ? { stroke: branchColor(t.branchId) } : undefined} />;
            })}
          </svg>
          {rows.map((t, i) => {
            const on = pathIds.has(t.id);
            const starts = i > 0 && t.parentId && row.has(t.parentId) && (nodes[t.parentId] as TurnNode | undefined)?.branchId !== t.branchId;
            return (
              <button
                key={t.id}
                className={`stp ${on ? 'path' : ''} ${t.id === selectedId ? 'sel' : ''}`}
                style={{ top: i * ROW, height: ROW, paddingLeft: pad, ['--branch' as any]: branchColor(t.branchId) }}
                onClick={() => onSelect(t.id)}
                onContextMenu={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, t }))}
                title={`${starts && purpose(t) ? `${purpose(t)}\n` : ''}${t.prompt}\n${STATUS_LABEL[t.status]}`}
              >
                <span className={`stp-dot ${dot(t)}`} style={{ left: laneX(lane(t)) - 5.5 }} />
                {starts && lanes.length > 1 && <span className="stp-lane">{'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[lane(t)] ?? '·'}</span>}
                <span className="stp-label">{stepLabel(t)}</span>
                {isLive(t) && <span className="stp-live">{t.status === 'waiting' ? 'needs you' : 'working'}</span>}
              </button>
            );
          })}
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuFor(menu.t)} onClose={() => setMenu(null)} />}
    </nav>
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
  onAsk,
  onRedo,
}: {
  stepId: string;
  /** Start a branch from a step with this prompt (a side question turned into a branch). */
  onBranch: (fromId: string, prompt: string) => void;
  /** Send a follow-up to a step (opening a PR, say). */
  onAsk: (nodeId: string, prompt: string) => void;
  /** Run a step's prompt again, as a new branch from the step before it. */
  onRedo: (node: TurnNode) => void;
  onSelect: (id: string) => void;
  /** The box under the thread: replies to `target` (the end of what you're reading, or a step you chose to branch from). */
  composer: (target: TurnNode, done: () => void, fork: boolean) => ReactNode;
  sideOpen: boolean;
  onToggleSide: () => void;
}) {
  useTick();
  const { nodes, branches, boards } = useStore();
  const ready = useReady();
  const step = nodes[stepId] as TurnNode;

  // The path being read stays put while you scroll through it; it only changes when you pick a
  // step that isn't on it (another branch on the left, a new reply).
  const [tipId, setTipId] = useState(() => tipFrom(nodes, stepId).id);
  const tipOk = !!nodes[tipId] && pathTo(nodes, tipId).some((t) => t.id === stepId);
  const tip = tipOk ? tipFrom(nodes, tipId) : tipFrom(nodes, stepId);
  useEffect(() => {
    if (tip.id !== tipId) setTipId(tip.id);
  }, [tip.id]);
  const fullPath = pathTo(nodes, tip.id);
  const pathIds = useMemo(() => new Set(fullPath.map((t) => t.id)), [fullPath.map((t) => t.id).join()]);
  const root = fullPath[0];
  // Steps above where you started the tree are hidden here too, and numbering starts from there.
  const from = root.startAt ? fullPath.findIndex((t) => t.id === root.startAt) : -1;
  const path = from > 0 ? fullPath.slice(from) : fullPath;
  const row = useMemo(() => threadsOf(nodes, branches, boards, ready, root.boardId).find((t) => t.root.id === root.id), [nodes, branches, boards, ready, root.id]);

  // Branching from a step: the box under the thread says so, until you send or cancel.
  const [branchFrom, setBranchFrom] = useState<string | null>(null);
  const [keeping, setKeeping] = useState<KeepMode | null>(null);
  const [tagging, setTagging] = useState<{ x: number; y: number } | null>(null);
  const board = boards.find((b) => b.id === root.boardId);
  const [jump, setJump] = useState<{ x: number; y: number } | null>(null);
  // The step list opens at the step you're on.
  useEffect(() => {
    if (jump) requestAnimationFrame(() => (document.querySelectorAll('.ctx .ctx-item')[index] as HTMLElement | undefined)?.scrollIntoView({ block: 'center' }));
  }, [jump]);
  useEffect(() => (setBranchFrom(null), setKeeping(null)), [root.id]);
  const target = (branchFrom && (nodes[branchFrom] as TurnNode)) || tip;

  // Reading position. Scrolling picks the step you're on (the steps on the left and the changes
  // follow); picking a step on the left or with J/K scrolls to it.
  // One step at a time: picking another step swaps the page to it, from the top, with no
  // scrolling through everything in between.
  const scroller = useRef<HTMLDivElement>(null);
  const select = (id: string) => onSelect(id);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [stepId]);
  // When the step you're reading is the latest and a new one starts after it, follow along.
  const lastTip = useRef(tip.id);
  useEffect(() => {
    if (tip.id !== lastTip.current && stepId === lastTip.current && pathIds.has(tip.id)) onSelect(tip.id);
    lastTip.current = tip.id;
  }, [tip.id]);
  // While the step you're reading streams, stay at the bottom if you were already there.
  const streamed = isLive(step) ? step.events.length + (step.events.at(-1)?.t === 'text' ? (step.events.at(-1) as any).text.length : 0) : 0;
  useEffect(() => {
    const sc = scroller.current;
    if (sc && streamed && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 160) sc.scrollTop = sc.scrollHeight;
  }, [streamed]);

  const index = path.findIndex((t) => t.id === stepId);
  // Reading a step that's now hidden: go to where the tree starts.
  useEffect(() => {
    if (index < 0 && path[0]) onSelect(path[0].id);
  }, [index, path[0]?.id]);
  // Which way you moved, so the step slides in from that side.
  const was = useRef(index);
  const dir = index > was.current ? 'next' : index < was.current ? 'prev' : 'same';
  useEffect(() => {
    was.current = index;
  }, [index]);
  const prev = index > 0 ? path[index - 1] : null;
  const next = index >= 0 && index < path.length - 1 ? path[index + 1] : null;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === 't' && board) {
        e.preventDefault();
        const r = document.querySelector('.rd-title-row .tg-chips')?.getBoundingClientRect();
        setTagging({ x: r?.left ?? 300, y: (r?.bottom ?? 100) + 6 });
      } else if (e.key === 'j' && next) select(next.id);
      else if (e.key === 'k' && prev) select(prev.id);
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  });

  const title = taskName(root);
  return (
    <TaskShell rootId={root.id} branchId={tip.branchId}>
    <section className="rd">
      <header className="rd-head">
        <div className="rd-title-row">
          <h1 className="rd-title" title={title}>
            {title}
          </h1>
          {board && (
            <TagChips
              tags={tagsOf(board, root)}
              onEdit={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setTagging({ x: r.left, y: r.bottom + 6 });
              }}
            />
          )}
          {row && (
            <span className={`rd-stage k-${statusKind(row)}`}>
              <StatusIcon kind={statusKind(row)} size={14} />
              {taskWord(row)}
            </span>
          )}
          <span className="spacer" />
          {row && <KeepButton row={row} tip={tip} onKeep={setKeeping} />}
          {path.length > 1 && (
            <button
              className="rd-pos"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setJump({ x: r.right - 260, y: r.bottom + 6 });
              }}
              title="Go to a step"
              aria-label={`Step ${index + 1} of ${path.length}. Go to a step`}
            >
              <Icon name="list" size={13} />
              {index + 1}/{path.length}
            </button>
          )}
          <NoteButton branchId={step.branchId} />
          <button className={`icon-btn sm ${sideOpen ? 'on' : ''}`} onClick={onToggleSide} title={sideOpen ? 'Hide changes (])' : 'Show changes (])'} aria-label="Changes panel" aria-pressed={sideOpen}>
            <Icon name="sidebar" size={15} />
          </button>
        </div>
        {jump && (
          <ContextMenu
            x={jump.x}
            y={jump.y}
            items={path.map((t, i) => ({
              label: `${i + 1}. ${stepLabel(t)}`,
              icon: i === index ? 'check' : t.status === 'error' ? 'x' : t.status === 'waiting' ? 'bell' : t.status === 'running' ? 'spark' : undefined,
              hint: t.status === 'error' ? 'failed' : t.status === 'waiting' ? 'needs you' : t.status === 'running' ? 'working' : undefined,
              onClick: () => select(t.id),
            }))}
            onClose={() => setJump(null)}
          />
        )}
      </header>
      <div className="rd-scroll" ref={scroller}>
        <SelectionAsk scroller={scroller} node={step} onBranch={(p) => onBranch(step.id, p)} />
        <div className={`rd-doc sv-doc go-${dir}`} key={stepId}>
          {index >= 0 && (
            <StepSection
              key={step.id}
              node={step}
              n={index + 1}
              total={path.length}
              from={branchFrom === step.id}
              others={childrenOf(nodes, step.id).filter((k) => !pathIds.has(k.id))}
              onBranchHere={() => (setBranchFrom(step.id), setTimeout(() => (document.querySelector('.rd-composer textarea') as HTMLTextAreaElement | null)?.focus(), 30))}
              onRedo={() => onRedo(step)}
              onGo={(id) => select(tipFrom(nodes, id).id)}
              onBranch={(p) => onBranch(step.id, p)}
            />
          )}
          {(prev || next) && (
            <nav className="sv-pager" aria-label="Steps">
              {prev ? (
                <button onClick={() => select(prev.id)} title="Previous step (K)">
                  <Icon name="chevronLeft" size={14} />
                  <span>
                    <small>Step {index}</small>
                    {stepLabel(prev)}
                  </span>
                </button>
              ) : (
                <span />
              )}
              {next && (
                <button className="next" onClick={() => select(next.id)} title="Next step (J)">
                  <span>
                    <small>Step {index + 2}</small>
                    {stepLabel(next)}
                  </span>
                  <Icon name="chevronRight" size={14} />
                </button>
              )}
            </nav>
          )}
          <div className="rd-end" />
        </div>
      </div>
      <div className="rd-composer">
        {branchFrom ? (
          <div className="rd-branching" style={{ ['--branch' as any]: branchColor(target.branchId) }}>
            <Icon name="branch" size={12} />
            New branch from step {path.findIndex((t) => t.id === target.id) + 1}: <b>{stepLabel(target)}</b>
            <span className="faint">Your other work stays as it is.</span>
            <span className="spacer" />
            <button onClick={() => setBranchFrom(null)}>Cancel</button>
          </div>
        ) : (
          row && <CallBar row={row} onJump={(id) => select(id)} />
        )}
        {composer(target, () => setBranchFrom(null), !!branchFrom)}
      </div>
      {tagging && board && <TagPicker board={board} root={root} x={tagging.x} y={tagging.y} onClose={() => setTagging(null)} />}
      {keeping && <KeepSheet root={root} tip={tip} start={keeping} onClose={() => setKeeping(null)} onAsk={(p) => onAsk(tip.id, p)} />}
    </section>
    </TaskShell>
  );
}

// ---------------- the one thing to do next ----------------

const PR_PROMPT =
  'Open a pull request for this work: make a new git branch, commit the changes with a clear message, push it, and open a PR with gh. Give it a short title and a description of what changed and why.';

/** Above the reply box: what this task needs from you now, with the buttons for it. */
type KeepMode = 'commit' | 'folder' | 'pr';

function CallBar({ row, onJump }: { row: ThreadRow; onJump: (id: string) => void }) {
  const { nodes } = useStore();
  const root = row.root;
  const steps = threadSteps(nodes, root.id);
  const waiting = steps.find((t) => t.status === 'waiting');
  const running = steps.find((t) => t.status === 'running');
  if (root.completed) return null;
  if (waiting)
    return (
      <div className="call needs">
        <StatusIcon kind="needs" size={16} />
        <span>
          <b>It's asking you</b> at “{stepLabel(waiting)}”
        </span>
        <span className="spacer" />
        <button className="btn sm primary" onClick={() => onJump(waiting.id)}>
          Show me
        </button>
      </div>
    );
  if (running)
    return (
      <div className="call working">
        <StatusIcon kind="working" size={16} />
        <span>
          Working on “{stepLabel(running)}” · <span className="faint">{currentActivity(running) || 'thinking'}</span>
        </span>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => send({ type: 'stop', nodeId: running.id })}>
          Stop
        </button>
      </div>
    );
  return null;
}

/**
 * In the header, once a task has finished: a small green Keep, with a menu for the other ways to
 * keep it and for Done and Discard. Its checks (tests, lint, builds it ran) show on hover.
 */
function KeepButton({ row, tip, onKeep }: { row: ThreadRow; tip: TurnNode; onKeep: (mode: KeepMode) => void }) {
  const { nodes, branches } = useStore();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const root = row.root;
  if (root.completed)
    return (
      <button className="hk-reopen" onClick={() => send({ type: 'setCompleted', nodeId: root.id, completed: false })} title="Put it back with your tasks">
        Reopen
      </button>
    );
  if (threadSteps(nodes, root.id).some(isLive)) return null;
  const own = !branches[tip.branchId]?.worktree;
  const discard = () => {
    send({ type: 'setDiscarded', nodeId: root.id, discarded: true });
    toast(own ? 'Discarded. It’s in History; files it changed in your folder stay as they are.' : 'Discarded. It’s in History, with its copy of the code, until you delete it for good.');
  };
  const checks = new Map<string, boolean>();
  for (const t of pathTo(nodes, tip.id))
    for (const e of t.events)
      if (e.t === 'tool' && e.name === 'Bash' && e.result != null) {
        const cmd = String((e.input as any)?.command ?? '').split('\n')[0].trim();
        if (/\b(test|tests|lint|typecheck|tsc|build|check|vitest|jest|pytest|bench)\b/.test(cmd)) checks.set(cmd, !e.isError);
      }
  const failing = [...checks].filter(([, ok]) => !ok).map(([c]) => c);
  const failed = tip.status === 'error' || failing.length > 0;
  const checkLine = !checks.size ? 'No checks ran' : failing.length ? `${failing.length} of ${checks.size} check${checks.size === 1 ? '' : 's'} failing: ${failing.join(', ')}` : `${checks.size === 1 ? 'Check' : `All ${checks.size} checks`} passed: ${[...checks.keys()].join(', ')}`;
  const open = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.right - 240, y: r.bottom + 6 });
  };
  const items: MenuItem[] = [
    ...(root.baseCommit
      ? [
          { label: 'Commit it', icon: 'check' as const, hint: 'as you', onClick: () => onKeep('commit') },
          { label: own ? 'Leave it uncommitted' : 'Put the changes in my folder', icon: 'folder' as const, onClick: () => onKeep('folder') },
          { label: 'Open a pull request', icon: 'branch' as const, hint: 'gh', onClick: () => onKeep('pr') },
          'sep' as const,
        ]
      : []),
    { label: 'Done', icon: 'check', hint: 'keep nothing', onClick: () => send({ type: 'setCompleted', nodeId: root.id, completed: true }) },
    { label: 'Discard', icon: 'trash', danger: true, onClick: discard },
  ];
  return (
    <>
      <span className={`hk ${failed ? 'quiet' : ''}`} title={`${checkLine}${root.baseCommit ? '\nNothing is committed until you keep it.' : ''}`}>
        {root.baseCommit ? (
          <button onClick={() => onKeep('commit')}>
            <StatusIcon kind={failed ? 'failed' : 'done'} size={13} />
            Keep
          </button>
        ) : (
          <button onClick={open}>Finish</button>
        )}
        <button className="hk-more" onClick={open} aria-label="More ways to finish" title="More">
          <Icon name="chevronDown" size={12} />
        </button>
      </span>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  );
}

/** Keep: commit on your branch, leave the changes in your folder, or have it open a PR. */
function KeepSheet({ root, tip, start, onClose, onAsk }: { root: TurnNode; tip: TurnNode; start: KeepMode; onClose: () => void; onAsk: (prompt: string) => void }) {
  const { branches, boards } = useStore();
  const own = !branches[tip.branchId]?.worktree;
  const board = boards.find((b) => b.id === root.boardId);
  const [mode, setMode] = useState<KeepMode>(start);
  const [msg, setMsg] = useState((root.title || root.prompt).split('\n')[0].slice(0, 72));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  const go = async () => {
    if (mode === 'pr') {
      onAsk(PR_PROMPT);
      toast('Asked it to open a pull request');
      return onClose();
    }
    setBusy(true);
    try {
      const k = await request<{ commit?: string; files: number }>({ type: 'keep', nodeId: tip.id, mode, message: msg });
      toast(k.commit ? `Committed ${k.commit} · ${k.files} file${k.files === 1 ? '' : 's'}` : `${k.files} file${k.files === 1 ? ' is' : 's are'} in your folder, uncommitted`);
      onClose();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const opt = (id: typeof mode, title: string, body: string, extra?: ReactNode) => (
    <label className={`ks-opt ${mode === id ? 'on' : ''}`}>
      <input type="radio" name="keep" checked={mode === id} onChange={() => setMode(id)} />
      <span>
        <b>{title}</b>
        <span>{body}</span>
        {mode === id && extra}
      </span>
    </label>
  );
  return (
    <div className="ks-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ks" role="dialog" aria-modal="true" aria-label="Keep this work">
        <h3>Keep “{root.title || stepLabel(root)}”</h3>
        {opt(
          'commit',
          'Commit it',
          `${own ? 'Commits the files it changed' : 'Brings the changes into your folder and commits them'}, as you, on the branch ${board?.name ? `your ${board.name} folder is on` : 'you are on'}.`,
          <input className="ks-msg" value={msg} onChange={(e) => setMsg(e.target.value)} aria-label="Commit message" autoFocus onKeyDown={(e) => e.key === 'Enter' && go()} />,
        )}
        {opt('folder', own ? 'Leave it uncommitted' : 'Just put the changes in my folder', own ? 'The changes are already in your folder. Close the task and commit them yourself later.' : 'Uncommitted, for you to look over and commit yourself.')}
        {opt('pr', 'Open a pull request', 'Asks the agent to push a new branch and open a PR with gh.')}
        <div className="ks-actions">
          <button className="btn primary keep" onClick={go} disabled={busy || (mode === 'commit' && !msg.trim())}>
            {busy ? 'Keeping…' : mode === 'pr' ? 'Ask for a PR' : 'Keep'}
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------- one step: what you asked, what it said, what it ran ----------------

type ToolEvent = Extract<TurnNode['events'][number], { t: 'tool' }>;

/** The commands a step ran: one line each with how it went; click one for the end of its output. Failures open on their own. */
function Commands({ node }: { node: TurnNode }) {
  const cmds = node.events.filter((e): e is ToolEvent => e.t === 'tool' && e.name === 'Bash');
  const run = useTaskRun();
  if (!cmds.length) return null;
  const tail = (r: string) =>
    r
      .split('\n')
      .filter((l) => l.trim())
      .slice(-6)
      .join('\n')
      .slice(-600);
  return (
    <section className="sv-sec">
      <h3>
        Ran <span>{cmds.length} command{cmds.length === 1 ? '' : 's'}</span>
      </h3>
      <div className="sv-cmds">
        {cmds.map((e) => {
          const full = String((e.input as any)?.command ?? '');
          const out = e.result ? tail(e.result) : '';
          return (
            <details key={e.id} className={`sv-cmd ${e.isError ? 'fail' : e.result == null ? 'run' : 'ok'}`} open={!!e.isError}>
              <summary title={full}>
                <span className="sv-cmd-mark">{e.result == null ? <span className="spinner" /> : e.isError ? '✕' : '✓'}</span>
                <code>{full.split('\n')[0]}</code>
                {run && full.trim() && (
                  <button
                    className="sv-run"
                    title={`Run it here\n${full}`}
                    aria-label="Run this command"
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      run(full);
                    }}
                  >
                    <Icon name="play" size={10} /> Run
                  </button>
                )}
                {out && <Icon name="chevronRight" size={12} className="fr-caret" />}
              </summary>
              {out && <pre>{out}</pre>}
            </details>
          );
        })}
      </div>
    </section>
  );
}

function StepSection({
  node,
  n,
  total,
  from,
  others,
  onBranchHere,
  onRedo,
  onGo,
  onBranch,
}: {
  node: TurnNode;
  n: number;
  total: number;
  from: boolean;
  others: TurnNode[];
  onBranchHere: () => void;
  onRedo: () => void;
  onGo: (id: string) => void;
  onBranch: (prompt: string) => void;
}) {
  const { branches } = useStore();
  const branch = branches[node.branchId];
  const working = isLive(node);
  const final = [...node.events].reverse().find((e) => e.t === 'text' && e.text.trim());
  const tools = node.events.filter((e) => e.t === 'tool').length;
  const edited = [...new Set(node.events.flatMap((e) => (e.t === 'tool' ? [editsOf(e)?.path].filter((p): p is string => !!p) : [])))];
  const copy = () => final?.t === 'text' && navigator.clipboard?.writeText(final.text).then(() => toast('Copied'), () => toast('Could not copy', 'error'));
  return (
    <article className={`sv ${from ? 'from' : ''} st-${node.status}`} data-step={node.id} style={{ ['--branch' as any]: branchColor(node.branchId) }}>
      <header className="sv-head">
        <span className="sv-badge" title={`Step ${n} of ${total}`}>
          {n}
        </span>
        <div className="sv-head-text">
          <h2 className="sv-title">{stepLabel(node)}</h2>
          <div className="sv-meta">
            {working ? <LiveLine node={node} /> : <span className={`sv-state s-${node.status}`}>{STATUS_LABEL[node.status]}</span>}
            <span title={new Date(node.finishedAt ?? node.createdAt).toLocaleString()}>
              <Icon name="clock" size={12} /> {timeAgo(node.finishedAt ?? node.createdAt)}
            </span>
            {node.durationMs ? <span>took {took(node.durationMs)}</span> : null}
            <DiffStat s={node.diffStat} />
          </div>
        </div>
      </header>
      <blockquote className="sv-you" title="What you asked">
        {node.prompt}
      </blockquote>
      <Attachments list={node.attachments} label={node.prompt} />
      {!!node.comments?.length && <CardComments node={node} roomy />}
      {node.pending && (
        <div className="ss-pending">
          <Permission node={node} p={node.pending} />
        </div>
      )}
      <div className="sv-answer">
        {final && final.t === 'text' ? <Md text={final.text} partial={working && final.partial} /> : <div className="ss-quiet">{working ? 'Working on it…' : 'Finished without a message.'}</div>}
        {node.error && <div className="error-box">{node.error}</div>}
      </div>
      <Commands node={node} />
      {edited.length > 0 && (
        <section className="sv-sec">
          <h3>
            Edited <span>{edited.length} file{edited.length === 1 ? '' : 's'}</span>
          </h3>
          <div className="ss-edits">
            {edited.map((p) => (
              <button key={p} onClick={() => dispatchEvent(new CustomEvent('forkspace:file', { detail: p }))} title={`${p}\nShow its changes`}>
                {p.split('/').pop()}
              </button>
            ))}
          </div>
        </section>
      )}
      <AsideList node={node} onBranch={onBranch} />
      {!working && (
        <div className="ss-acts sv-acts">
          {node.sessionId && (
            <button onClick={onBranchHere} title="Try something different from this point. Your other work stays as it is.">
              <Icon name="branch" size={12} /> Branch from here
            </button>
          )}
          {node.parentId && (
            <button onClick={onRedo} title="Run this step again as a new branch, to compare">
              <Icon name="refresh" size={12} /> Redo this step
            </button>
          )}
          {final && (
            <button onClick={copy} title="Copy what it said">
              <Icon name="copy" size={12} /> Copy
            </button>
          )}
        </div>
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
      {tools > 0 && (
        <details className="ss-how sv-how">
          <summary>
            <Icon name="chevronRight" size={12} className="fr-caret" />
            Everything it did <span className="faint">· {tools} action{tools === 1 ? '' : 's'}</span>
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
  // An "Edited" chip in a step asks to see one file: open it here and bring it into view.
  const [want, setWant] = useState<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: Event) => setWant(String((e as CustomEvent).detail));
    addEventListener('forkspace:file', on);
    return () => removeEventListener('forkspace:file', on);
  }, []);
  useEffect(() => {
    if (!want || diff == null) return;
    const f = files.find((x) => want === x.path || want.endsWith('/' + x.path));
    setWant(null);
    if (!f) return void toast('No changes to that file in this step');
    const el = scroll.current?.querySelector(`[data-path="${CSS.escape(f.path)}"]`) as HTMLDetailsElement | null;
    if (!el) return;
    el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
  }, [want, diff]);
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
      <div className="cp-scroll" ref={scroll}>
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
              <details key={f.path} className="cp-file" data-path={f.path} open={files.length <= 3 || i === 0}>
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

