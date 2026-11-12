import { Handle, NodeResizer, Position, useStore as useRFStore, type NodeProps } from '@xyflow/react';
import { CardComments, startComment } from './Comments.tsx';
import { memo, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Markdown } from './Markdown.tsx';
import { Attachments, ShotThumb, openShots, readImageText, stepShots, uploadNoteImage } from './Shots.tsx';
import type { NoteNode, PendingPermission, TurnEvent, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { send, useStore, toast } from './store.ts';
import { currentActivity, isLive, lastText } from './tree.ts';
import { useReady } from './review.ts';

export const NOTE_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#e9d5ff', '#e5e7eb'];

// Muted on purpose: colour tells branches apart without shouting.
export const BRANCH_COLORS = ['#8f9bd9', '#c7a46e', '#72ad92', '#b78ba6', '#9d93cc', '#6ea7b3', '#c08787', '#97aa75'];

/** Only things that just appeared get an entrance animation (never replays on view switches). */
export const isFresh = (t?: number) => !!t && Date.now() - t < 4000;
export function branchColor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BRANCH_COLORS[h % BRANCH_COLORS.length];
}

export const STATUS_LABEL: Record<TurnNode['status'], string> = {
  running: 'Working',
  waiting: 'Needs you',
  done: 'Done',
  error: 'Failed',
  stopped: 'Stopped',
};

export function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.file_path ?? input.command ?? input.pattern ?? input.url ?? input.description ?? input.query ?? input.prompt ?? input.path;
  if (typeof v === 'string') return v.replace(/\s+/g, ' ');
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return '';
}

const base = (p: unknown) => (typeof p === 'string' ? p.split('/').filter(Boolean).pop() ?? p : '');

/** What a tool call is doing, in a few plain words: "Editing math.ts", "Running npm test". */
export function toolHuman(name: string, input: any): { verb: string; what?: string } {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'Editing', what: base(i.file_path ?? i.notebook_path) };
    case 'Write':
      return { verb: 'Writing', what: base(i.file_path) };
    case 'Read':
      return { verb: 'Reading', what: base(i.file_path) };
    case 'Bash':
      return { verb: 'Running', what: String(i.command ?? '').replace(/\s+/g, ' ').slice(0, 48) };
    case 'Grep':
      return { verb: 'Searching for', what: String(i.pattern ?? '').slice(0, 32) };
    case 'Glob':
      return { verb: 'Finding', what: String(i.pattern ?? 'files').slice(0, 32) };
    case 'WebFetch':
      try {
        return { verb: 'Reading', what: new URL(String(i.url)).hostname };
      } catch {
        return { verb: 'Reading the web' };
      }
    case 'WebSearch':
      return { verb: 'Searching the web', what: String(i.query ?? '').slice(0, 32) };
    case 'Task':
    case 'Agent':
      return { verb: 'Asking a helper', what: String(i.description ?? '').slice(0, 32) };
    case 'TodoWrite':
      return { verb: 'Planning' };
    case 'AskUserQuestion':
      return { verb: 'Asking you' };
    default:
      return { verb: name.replace(/^mcp__\w+__/, '').replace(/_/g, ' ') };
  }
}

/** What a working card is doing right now (null when it isn't working). */
export function liveActivity(node: TurnNode): { verb: string; what?: string; waiting?: boolean } | null {
  if (node.status === 'waiting') {
    if (!node.pending) return { verb: 'Needs you', waiting: true };
    const t = toolHuman(node.pending.toolName, node.pending.input);
    return { verb: node.pending.toolName === 'AskUserQuestion' ? 'Has a question' : 'Needs your OK', what: t.what || t.verb, waiting: true };
  }
  if (node.status !== 'running') return null;
  for (let k = node.events.length - 1; k >= 0; k--) {
    const e = node.events[k];
    if (e.t === 'tool') return e.result == null ? toolHuman(e.name, e.input) : { verb: 'Thinking' };
    if (e.t === 'text') return e.partial ? { verb: 'Writing the answer' } : { verb: 'Thinking' };
  }
  return { verb: 'Starting' };
}

/** The live line: what the agent is doing, changing as it works. */
export function LiveLine({ node, big = false }: { node: TurnNode; big?: boolean }) {
  const a = liveActivity(node);
  if (!a) return null;
  const k = `${a.verb}|${a.what ?? ''}`;
  return (
    <span key={k} className={`live-line ${big ? 'big' : ''} ${a.waiting ? 'waiting' : ''}`}>
      <b>{a.verb}</b>
      {a.what && <code>{a.what}</code>}
      {!a.waiting && <i className="live-caret" />}
    </span>
  );
}

export const money = (n?: number) => (n == null ? '' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

/**
 * Lets a scrollable area inside a card or note scroll its own content when it can, and hands the
 * wheel to the canvas otherwise (pan, and pinch or ⌘-scroll always zooms). Never blocks the canvas.
 */
export function OwnScroll({ as: Tag = 'div', className, children, ...rest }: { as?: 'div' | 'pre'; className?: string; children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return; // zoom: always the canvas
      const down = e.deltaY > 0;
      const can = down ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : e.deltaY < 0 && el.scrollTop > 0;
      if (can) e.stopPropagation(); // this box scrolls; the canvas stays put
    };
    el.addEventListener('wheel', h, { passive: true });
    return () => el.removeEventListener('wheel', h);
  }, []);
  return (
    <Tag ref={ref as any} className={className} {...rest}>
      {children}
    </Tag>
  );
}

export function StatusDot({ status }: { status: TurnNode['status'] }) {
  return <span className={`dot ${status}`} aria-label={STATUS_LABEL[status]} />;
}

/** Tiny, safe markdown: fenced code, inline code, bold. Rendered as React nodes, never HTML. */
/** A code block with a copy button in its corner. */
export function CodeBlock({ code, className = 'code' }: { code: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="code-wrap">
      <pre className={className}>{code}</pre>
      <button
        className={`code-copy ${done ? 'done' : ''}`}
        title={done ? 'Copied' : 'Copy'}
        aria-label="Copy code"
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard?.writeText(code).then(
            () => {
              setDone(true);
              setTimeout(() => setDone(false), 1400);
            },
            () => toast('Could not copy', 'error'),
          );
        }}
      >
        <Icon name={done ? 'check' : 'copy'} size={13} />
      </button>
    </div>
  );
}

export function Md({ text, partial }: { text: string; partial?: boolean }) {
  return (
    <div className={`md ${partial ? 'partial' : ''}`}>
      <Markdown text={text} code={(code, _lang, key) => <CodeBlock key={key} code={code} />} />
    </div>
  );
}

export function ToolLine({ e, cwd }: { e: Extract<TurnEvent, { t: 'tool' }>; cwd?: string }) {
  const state = e.result == null ? 'pending' : e.isError ? 'err' : 'ok';
  const arg = toolSummary(e.name, e.input);
  return (
    <div className={`tool-line ${state}`}>
      <span className="tool-mark">{state === 'pending' ? <span className="spinner" /> : <Icon name={state === 'err' ? 'x' : 'check'} size={12} />}</span>
      <span className="tool-name">{e.name}</span>
      <span className="tool-arg" title={arg}>
        {cwd ? arg.split(cwd + '/').join('').split(cwd).join('.') : arg}
      </span>
    </div>
  );
}

export function Permission({ node, p }: { node: TurnNode; p: PendingPermission }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const cwd = useStore().branches[node.branchId]?.cwd;
  const short = (s: string) => (cwd ? s.split(cwd + '/').join('').split(cwd).join('.') : s);
  const reply = (decision: 'allow' | 'always' | 'deny', extra?: object) =>
    send({ type: 'permission', nodeId: node.id, requestId: p.requestId, decision, ...extra });

  const questions = p.toolName === 'AskUserQuestion' && Array.isArray((p.input as any).questions) ? ((p.input as any).questions as any[]) : null;
  if (questions)
    return (
      <div className="perm nodrag">
        <div className="perm-label">
          <Icon name="chat" size={13} /> The agent has a question
        </div>
        {questions.map((q) => (
          <div key={q.question} className="perm-q">
            <div className="perm-title">{q.question}</div>
            <div className="perm-opts">
              {q.options?.map((o: any) => {
                const picked = (answers[q.question] ?? '').split(', ').includes(o.label);
                return (
                  <button
                    key={o.label}
                    className={`chip ${picked ? 'on' : ''}`}
                    title={o.description}
                    onClick={() => {
                      const cur = (answers[q.question] ?? '').split(', ').filter(Boolean);
                      const next = q.multiSelect ? (picked ? cur.filter((l) => l !== o.label) : [...cur, o.label]) : [o.label];
                      setAnswers({ ...answers, [q.question]: next.join(', ') });
                    }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="perm-actions">
          <button className="btn primary" disabled={questions.some((q) => !answers[q.question])} onClick={() => reply('allow', { answers })}>
            Send answer
          </button>
          <button className="btn subtle" onClick={() => reply('deny', { message: 'The user skipped the question.' })}>
            Skip
          </button>
        </div>
      </div>
    );

  return (
    <div className={`perm nodrag ${p.safety ? 'perm-safety' : ''}`}>
      <div className="perm-label">
        <Icon name="shield" size={13} />
        <span>{p.safety ? p.safety : <>Allow <b>{p.toolName}</b>?</>}</span>
      </div>
      <OwnScroll as="pre" className="perm-input">
        {short(toolSummary(p.toolName, p.input) || JSON.stringify(p.input, null, 2))}
      </OwnScroll>
      <div className="perm-actions">
        <button className="btn primary" onClick={() => reply('allow')}>
          Allow
        </button>
        {p.canAlways && (
          <button className="btn subtle" onClick={() => reply('always')} title="Allow this kind of call for the rest of the session">
            Always
          </button>
        )}
        <span className="spacer" />
        <button className="btn danger-ghost" onClick={() => reply('deny')}>
          Deny
        </button>
      </div>
    </div>
  );
}

export function DiffStat({ s }: { s?: TurnNode['diffStat'] }) {
  if (!s || !s.files) return null;
  return (
    <span className="diffstat">
      <Icon name="file" size={12} />
      {s.files} <span className="add">+{s.insertions}</span> <span className="del">−{s.deletions}</span>
    </span>
  );
}

export interface TurnData extends Record<string, unknown> {
  node: TurnNode;
  onOpen: (id: string) => void;
  onReply: (id: string) => void;
  isTarget: boolean;
  /** An earlier step was marked complete: this one fades back too. */
  faded?: boolean;
  /** On a thread's first card: every screenshot in the thread, newest last. */
  cover?: { id: string; node: TurnNode }[];
}

/**
 * One circle per thread, floating above its first card and joined to it by a short line.
 * Click it when the thread is finished: it fills with a green tick and the whole thread fades back.
 */
function ThreadDone({ node, cover }: { node: TurnNode; cover?: { id: string; node: TurnNode }[] }) {
  const on = !!node.completed;
  return (
    <div className={`thread-done nodrag ${on ? 'on' : ''}`}>
      <button
        className="complete-circle"
        title={on ? 'Thread complete. Click to reopen' : 'Mark this thread complete'}
        aria-label={on ? 'Reopen thread' : 'Mark thread complete'}
        aria-pressed={on}
        onClick={(e) => {
          e.stopPropagation();
          send({ type: 'setCompleted', nodeId: node.id, completed: !on });
        }}
      >
        <Icon name="check" size={13} strokeWidth={3} />
      </button>
      <span className="thread-done-line" />
      {!!cover?.length && (
        <>
          <ShotThumb id={cover[cover.length - 1].id} className="thread-cover" count={cover.length} onOpen={() => openShots(stepShots(cover))} />
          <span className="thread-done-line short" />
        </>
      )}
      <ThreadTitle node={node} />
      <span className="thread-done-line short" />
    </div>
  );
}

/** The thread's title, under its circle. Click to rename. */
function ThreadTitle({ node }: { node: TurnNode }) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(node.title ?? '');
  useEffect(() => setText(node.title ?? ''), [node.title]);
  const save = () => {
    setEdit(false);
    if (text.trim() !== (node.title ?? '')) send({ type: 'setTitle', nodeId: node.id, title: text });
  };
  if (edit)
    return (
      <input
        className="thread-title editing"
        autoFocus
        value={text}
        maxLength={80}
        placeholder="Name this thread"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') {
            setText(node.title ?? '');
            setEdit(false);
          }
        }}
      />
    );
  return (
    <button
      className={`thread-title ${node.title ? '' : 'empty'}`}
      title="Click to rename"
      onClick={(e) => {
        e.stopPropagation();
        setEdit(true);
      }}
    >
      {node.title ?? (isLive(node) ? 'Naming…' : 'Add a title')}
    </button>
  );
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Files this step changed, relative to its folder. */
function editedFiles(node: TurnNode, cwd?: string) {
  const out: string[] = [];
  for (const e of node.events) {
    if (e.t !== 'tool' || !EDIT_TOOLS.has(e.name)) continue;
    const p = (e.input as any)?.file_path ?? (e.input as any)?.notebook_path;
    if (typeof p !== 'string') continue;
    const rel = cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

export const TurnCard = memo(function TurnCard({ data }: NodeProps & { data: TurnData }) {
  const { node, onOpen, onReply, isTarget, faded } = data;
  const dim = node.completed ? 'completed' : faded ? 'faded' : '';
  const { branches } = useStore();
  // Zoomed far out: show just the essentials so big boards stay readable.
  const far = useRFStore((st) => st.transform[2] < 0.55);
  const [steps, setSteps] = useState(false);
  const branch = branches[node.branchId];
  const color = branchColor(node.branchId);
  const live = isLive(node);
  const isHead = branch?.headNodeId === node.id;
  const tools = node.events.filter((e): e is Extract<TurnEvent, { t: 'tool' }> => e.t === 'tool');
  const files = editedFiles(node, branch?.cwd);
  const lessons = (node.lessons ?? []).filter((l) => !l.reviewed);
  const summary = live ? '' : lastText(node);
  // Finished while you weren't looking: marked until you click it or start the next step.
  const ready = useReady().has(node.id) && !live && !node.completed;
  const readyPill = ready && (
    <span className={`ready-pill ${node.status}`}>
      <Icon name={node.status === 'error' ? 'x' : 'check'} size={11} strokeWidth={3} />
      {node.status === 'error' ? 'Failed, take a look' : 'Ready for review'}
    </span>
  );

  const root = !node.parentId;
  // A card that just appeared slides in; older ones don't replay it when the view changes.
  const fresh = Date.now() - node.createdAt < 6000;
  if (far)
    return (
      <>
      {root && <ThreadDone node={node} cover={data.cover} />}
      <div className={`turn far status-${node.status} ${isTarget ? 'target' : ''} ${dim} ${fresh ? 'fresh' : ''} ${ready ? 'is-ready' : ''}`} style={{ ['--branch' as any]: color }}>
        <Handle type="target" position={Position.Top} />
        <div className="far-status">
          <StatusDot status={node.status} />
          {isLive(node) ? <LiveLine node={node} big /> : readyPill || STATUS_LABEL[node.status]}
          {lessons.length > 0 && (
            <span className="far-concepts">
              <span className="mentor-orb small" /> {lessons.length}
            </span>
          )}
        </div>
        <div className="far-prompt">{node.prompt}</div>
        <Handle type="source" position={Position.Bottom} />
      </div>
      </>
    );

  return (
    <>
    {root && <ThreadDone node={node} cover={data.cover} />}
    <div className={`turn status-${node.status} ${isTarget ? 'target' : ''} ${isFresh(node.createdAt) ? 'fresh' : ''} ${dim} ${ready ? 'is-ready' : ''}`} style={{ ['--branch' as any]: color }}>
      <Handle type="target" position={Position.Top} />
      <div className="turn-head">
        {!node.completed && <StatusDot status={node.status} />}
        {live ? <LiveLine node={node} /> : readyPill || <span className="status-label">{node.completed ? 'Completed' : STATUS_LABEL[node.status]}</span>}
        <span className="spacer" />
        {!!node.queued?.length && (
          <span className="queued-pill" title={node.queued.map((q) => q.prompt).join('\n\n')}>
            <Icon name="clock" size={11} />
            {node.queued.length} queued
          </span>
        )}
        {node.imported ? (
          <span className="branch-tag" title="Brought in from Claude Code">
            <Icon name="download" size={11} />
            Claude Code
          </span>
        ) : (
          <span className="branch-tag" title={branch?.gitBranch ?? 'branch'}>
            <Icon name="branch" size={11} />
            {node.branchId.slice(0, 6)}
          </span>
        )}
      </div>

      <div className="turn-prompt">{node.prompt}</div>
      <Attachments list={node.attachments} label={node.prompt} />
      {!!node.shots?.length && (
        <ShotThumb
          id={node.shots[node.shots.length - 1]}
          className="turn-shot"
          count={node.shots.length}
          onOpen={() => openShots(stepShots(node.shots!.map((id) => ({ id, node }))))}
        />
      )}

      {live ? (
        <div className="turn-live">
          <span className="spinner" />
          <span className="ellipsis">{currentActivity(node)}</span>
        </div>
      ) : (
        summary && <div className="turn-summary">{summary}</div>
      )}
      {node.error && <div className="error-box turn-error">{node.error}</div>}

      {files.length > 0 && (
        <div className="turn-files">
          {files.slice(0, 3).map((f) => (
            <span key={f} className="file-chip" title={f}>
              <Icon name="file" size={11} />
              {f.split('/').pop()}
            </span>
          ))}
          {files.length > 3 && <span className="file-chip more">+{files.length - 3}</span>}
          <DiffStat s={node.diffStat} />
        </div>
      )}

      {(lessons.length > 0 || node.learning) && (
        <div className="turn-concepts nodrag">
          {lessons.slice(-2).map((l) => (
            <button key={l.id} className="concept-chip" onClick={() => onOpen(node.id)} title={l.body}>
              <span className="mentor-orb small" />
              <span className="ellipsis">{l.title}</span>
            </button>
          ))}
          {lessons.length > 2 && (
            <button className="concept-chip more" onClick={() => onOpen(node.id)}>
              +{lessons.length - 2}
            </button>
          )}
          {node.learning && (
            <span className="concept-chip pending">
              <span className="mentor-orb small" />
              <span className="shimmer-text">Finding a concept…</span>
            </span>
          )}
        </div>
      )}

      {tools.length > 0 && (
        <button className="steps-toggle nodrag" onClick={() => setSteps(!steps)}>
          <Icon name="chevronRight" size={12} className={steps ? 'open' : ''} />
          {tools.length} step{tools.length === 1 ? '' : 's'}
        </button>
      )}
      {steps && (
        <OwnScroll className="turn-body">
          {tools.map((e) => (
            <ToolLine key={e.id} e={e} cwd={branch?.cwd} />
          ))}
        </OwnScroll>
      )}

      {node.pending && <Permission node={node} p={node.pending} />}

      <div className="turn-foot nodrag">
        <button className="btn ghost sm" onClick={() => onOpen(node.id)}>
          Details
        </button>

        <span className="spacer" />
        {live ? (
          <button className="btn danger-ghost sm" onClick={() => send({ type: 'stop', nodeId: node.id })}>
            <Icon name="stop" size={12} /> Stop
          </button>
        ) : (
          node.sessionId && (
            <button className="btn sm" onClick={() => onReply(node.id)} title={isHead ? 'Continue this branch' : 'Start a new branch from here'}>
              <Icon name={isHead ? 'chat' : 'branch'} size={13} /> {isHead ? 'Reply' : 'Branch'}
            </button>
          )
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
    <button className="cmt-plus nodrag" onClick={() => startComment(node.id)} title="Add a comment (only for you)" aria-label="Add a comment">
      <Icon name="plus" size={13} />
    </button>
    <CardComments node={node} />
    </>
  );
});

export interface NoteData extends Record<string, unknown> {
  node: NoteNode;
}

/** Renders a note: checklists you can tick, bullets, headings and **bold**. */
export function NoteText({ text, onToggle }: { text: string; onToggle: (line: number) => void }) {
  const bold = (t: string) => t.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : p));
  return (
    <div className="note-text">
      {text.split('\n').map((line, i) => {
        const task = line.match(/^\s*[-*] \[( |x|X)\] ?(.*)$/);
        if (task)
          return (
            <label key={i} className={`note-task ${task[1] !== ' ' ? 'done' : ''}`} onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" className="nodrag" checked={task[1] !== ' '} onChange={() => onToggle(i)} />
              <span>{bold(task[2])}</span>
            </label>
          );
        const bullet = line.match(/^\s*[-*] (.*)$/);
        if (bullet)
          return (
            <div key={i} className="note-bullet">
              {bold(bullet[1])}
            </div>
          );
        const head = line.match(/^#{1,3} (.*)$/);
        if (head)
          return (
            <div key={i} className="note-head">
              {bold(head[1])}
            </div>
          );
        return line.trim() ? (
          <div key={i} className="note-line">
            {bold(line)}
          </div>
        ) : (
          <div key={i} className="note-gap" />
        );
      })}
    </div>
  );
}

/** A small, steady tilt per note so a board of notes feels like paper, not a grid. */
const tilt = (id: string) => ((id.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 7) - 3) * 0.3;

export const NoteCard = memo(function NoteCard({ data, selected }: NodeProps & { data: NoteData }) {
  const { node } = data;
  const [text, setText] = useState(node.text);
  const [editing, setEditing] = useState(() => !node.text && Date.now() - node.createdAt < 5000);
  const timer = useRef<number | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setText(node.text);
  }, [node.text]);
  useEffect(() => {
    if (editing) setTimeout(() => area.current?.focus(), 0);
  }, [editing]);
  // Notes grow to fit what's in them, so nothing hides inside and the wheel always moves the canvas.
  const view = useRef<HTMLDivElement>(null);
  const grownFor = useRef('');
  useEffect(() => {
    const el = editing ? area.current : view.current;
    const box = el?.closest('.note') as HTMLElement | null;
    if (!el || !box) return;
    const extra = el.scrollHeight - el.clientHeight;
    const key = `${text.length}|${node.images?.length ?? 0}|${editing}`;
    if (extra > 2 && grownFor.current !== key) {
      grownFor.current = key;
      // scrollHeight and clientHeight are layout sizes (not affected by zoom), same units as the node.
      const h = Math.min(1200, Math.round((node.height ?? 160) + extra + 8));
      send({ type: 'move', moves: [{ id: node.id, position: node.position, width: node.width ?? 220, height: h }] });
    }
  }, [text, editing, node.images?.length, node.height]);

  const save = (patch: Partial<NoteNode>) => send({ type: 'upsertNote', note: { ...node, ...patch } });
  const commit = (v: string) => {
    clearTimeout(timer.current);
    if (v !== node.text) save({ text: v });
  };
  const toggle = (line: number) => {
    const lines = text.split('\n');
    lines[line] = lines[line].replace(/\[( |x|X)\]/, (_, c) => (c === ' ' ? '[x]' : '[ ]'));
    const v = lines.join('\n');
    setText(v);
    save({ text: v });
  };
  // An image arrived (paste or drop): ask what to do with it.
  const [incoming, setIncoming] = useState<{ file: Blob; url: string } | null>(null);
  const [reading, setReading] = useState(false);
  const caretAt = useRef<number | null>(null);
  const offer = (file: Blob) => {
    caretAt.current = editing && area.current ? area.current.selectionStart : null;
    setIncoming((old) => {
      if (old) URL.revokeObjectURL(old.url);
      return { file, url: URL.createObjectURL(file) };
    });
  };
  const dismiss = () => {
    if (incoming) URL.revokeObjectURL(incoming.url);
    setIncoming(null);
    setReading(false);
  };
  /** Grow the note so what was just added fits (never shrinks what you sized yourself). */
  const fit = (v: string, images: number) => {
    const lines = v.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 30)), 0);
    const want = 46 + lines * 21 + (images ? 70 : 0) + (/\[( |x|X)\]/.test(v) ? 28 : 0);
    const h = node.height ?? 160;
    return want > h ? { height: Math.min(640, want) } : {};
  };
  const asImage = async () => {
    if (!incoming) return;
    try {
      const grow = fit(text, (node.images?.length ?? 0) + 1);
      if (grow.height) send({ type: 'move', moves: [{ id: node.id, position: node.position, width: node.width ?? 220, height: grow.height }] });
      await uploadNoteImage(node.id, incoming.file);
    } catch (e: any) {
      toast(e.message, 'error');
    }
    dismiss();
  };
  const asText = async () => {
    if (!incoming) return;
    setReading(true);
    try {
      const got = (await readImageText(incoming.file)).trim();
      if (!got) toast('No text found in that image.');
      else {
        const at = caretAt.current;
        const v = at != null ? text.slice(0, at) + got + text.slice(at) : text.trim() ? `${text.replace(/\s+$/, '')}\n${got}` : got;
        setText(v);
        save({ text: v, ...fit(v, node.images?.length ?? 0) });
      }
    } catch (e: any) {
      toast(e.message, 'error');
    }
    dismiss();
  };
  // Pasting while the note is selected (not typing in it).
  useEffect(() => {
    if (!selected || editing) return;
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      offer(file);
    };
    addEventListener('paste', onPaste, true);
    return () => removeEventListener('paste', onPaste, true);
  }, [selected, editing]);

  const tasks = text.match(/^\s*[-*] \[( |x|X)\]/gm) ?? [];
  const doneCount = tasks.filter((t) => /\[(x|X)\]/.test(t)).length;

  return (
    <div
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onDrop={(e) => {
        const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
        if (!file) return;
        e.preventDefault();
        e.stopPropagation();
        offer(file);
      }}
      className={`note ${selected ? 'selected' : ''} ${editing ? 'editing' : ''} ${isFresh(node.createdAt) ? 'fresh' : ''}`}
      style={{ ['--paper' as any]: node.color, ['--tilt' as any]: `${editing || selected ? 0 : tilt(node.id)}deg` }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={170}
        minHeight={110}
        lineClassName="note-resize-line"
        handleClassName="note-resize-handle"
        onResizeEnd={(_, p) => send({ type: 'move', moves: [{ id: node.id, position: { x: p.x, y: p.y }, width: p.width, height: p.height }] })}
      />
      <Handle type="target" position={Position.Top} />
      <div className="note-bar">
        <span className="note-grip" title="Drag to move">
          <i />
          <i />
          <i />
        </span>
        <span className="spacer" />
        {NOTE_COLORS.map((c) => (
          <button key={c} className={`swatch nodrag ${c === node.color ? 'on' : ''}`} style={{ background: c }} onClick={() => save({ color: c })} aria-label="Note colour" />
        ))}
        <button
          className="note-tool nodrag"
          title="Add a checklist item"
          aria-label="Add a checklist item"
          onClick={() => {
            const v = text && !text.endsWith('\n') ? `${text}\n- [ ] ` : `${text}- [ ] `;
            setText(v);
            setEditing(true);
          }}
        >
          <Icon name="check" size={12} strokeWidth={2.5} />
        </button>
        <button
          className="note-tool nodrag"
          title="Move to Notes (keeps it, off the canvas)"
          aria-label="Move to Notes"
          onClick={() => {
            save({ filed: true });
            toast('Moved to Notes');
          }}
        >
          <Icon name="folder" size={12} />
        </button>
        <button className="note-tool nodrag" title="Delete note" aria-label="Delete note" onClick={() => send({ type: 'deleteNodes', ids: [node.id] })}>
          <Icon name="trash" size={12} />
        </button>
      </div>
      {editing ? (
        <textarea
          ref={area}
          className="nodrag"
          value={text}
          placeholder={'Write anything…\n- [ ] makes a checklist'}
          onBlur={() => {
            if (incoming) return; // the choice below is still open
            setEditing(false);
            commit(text);
          }}
          onPaste={(e) => {
            const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
            if (!file) return;
            e.preventDefault();
            e.stopPropagation();
            offer(file);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              (e.target as HTMLTextAreaElement).blur();
              return;
            }
            // Lists continue on Enter; an empty item ends the list.
            if (e.key === 'Enter' && !e.shiftKey) {
              const el = e.currentTarget;
              const before = text.slice(0, el.selectionStart);
              const line = before.slice(before.lastIndexOf('\n') + 1);
              const m = line.match(/^(\s*[-*] (\[[ xX]\] )?)(.*)$/);
              if (!m) return;
              e.preventDefault();
              const prefix = m[1].replace(/\[[xX]\]/, '[ ]');
              const v = !m[3].trim() ? text.slice(0, el.selectionStart - line.length) + text.slice(el.selectionStart) : `${before}\n${prefix}${text.slice(el.selectionStart)}`;
              const caret = !m[3].trim() ? el.selectionStart - line.length : before.length + 1 + prefix.length;
              // Update the text and put the cursor right after the new bullet in the same moment,
              // so fast typing never lands in the wrong place.
              flushSync(() => setText(v));
              el.setSelectionRange(caret, caret);
            }
          }}
          onChange={(e) => {
            setText(e.target.value);
            clearTimeout(timer.current);
            const v = e.target.value;
            timer.current = window.setTimeout(() => save({ text: v }), 700);
          }}
        />
      ) : (
        <div ref={view} className="note-view" onClick={() => setEditing(true)} title="Click to edit">
          {text.trim() ? <NoteText text={text} onToggle={toggle} /> : <span className="note-placeholder">Write anything…</span>}
        </div>
      )}
      {!!node.images?.length && (
        <div className="note-images">
          {node.images.map((id, i) => (
            <ShotThumb
              key={id}
              id={id}
              className="note-image"
              onOpen={() =>
                openShots(
                  node.images!.map((x) => ({
                    id: x,
                    label: node.text.split('\n')[0].replace(/^#+\s*/, '') || 'Note',
                    remove: () => send({ type: 'upsertNote', note: { ...node, images: node.images!.filter((y) => y !== x) } }),
                  })),
                  i,
                )
              }
            />
          ))}
        </div>
      )}
      {incoming && (
        <div className="note-ask nodrag" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.preventDefault()}>
          <img src={incoming.url} alt="" />
          {reading ? (
            <div className="note-ask-reading">
              <span className="mentor-orb small" /> <span className="shimmer-text">Reading the text…</span>
            </div>
          ) : (
            <>
              <button className="note-ask-x" onClick={dismiss} aria-label="Cancel" title="Cancel">
                <Icon name="x" size={11} />
              </button>
              <span className="note-ask-q">Add this image?</span>
              <div className="note-ask-row">
                <button onClick={asImage}>
                  <Icon name="file" size={12} /> Add image
                </button>
                <button onClick={asText}>
                  <Icon name="spark" size={12} /> Turn into text
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {tasks.length > 0 && (
        <div className="note-foot">
          <span className="note-progress">
            <i style={{ width: `${(doneCount / tasks.length) * 100}%` }} />
          </span>
          {doneCount} of {tasks.length} done
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});
