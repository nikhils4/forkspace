import { Handle, NodeResizer, Position, useStore as useRFStore, type NodeProps } from '@xyflow/react';
import { memo, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { NoteNode, PendingPermission, TurnEvent, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { send, useStore, toast } from './store.ts';
import { currentActivity, isLive, lastText } from './tree.ts';

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

export const money = (n?: number) => (n == null ? '' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

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
  const parts = text.split(/```[^\n]*\n?/);
  return (
    <div className={`md ${partial ? 'partial' : ''}`}>
      {parts.map((p, i) =>
        i % 2 ? (
          <CodeBlock key={i} code={p.replace(/\n$/, '')} />
        ) : (
          <Prose key={i} text={p} />
        ),
      )}
    </div>
  );
}

const inline = (s: string) =>
  s.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((t, j) =>
    t.startsWith('`') && t.endsWith('`') && t.length > 2 ? (
      <code key={j}>{t.slice(1, -1)}</code>
    ) : t.startsWith('**') && t.endsWith('**') && t.length > 4 ? (
      <b key={j}>{t.slice(2, -2)}</b>
    ) : (
      t
    ),
  );

/** Paragraph text with "- " / "* " / "1. " lines turned into real lists. */
function Prose({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  let buf: string[] = [];
  const flushText = () => {
    if (buf.length) out.push(<span key={out.length}>{inline(buf.join('\n'))}</span>);
    buf = [];
  };
  const flushList = () => {
    if (list.length)
      out.push(
        <ul key={out.length} className="md-list">
          {list.map((l, i) => (
            <li key={i}>{inline(l)}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (m) {
      flushText();
      list.push(m[1]);
    } else {
      if (list.length && !line.trim()) continue;
      flushList();
      buf.push(line);
    }
  }
  flushText();
  flushList();
  return <>{out}</>;
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
    <div className="perm nodrag">
      <div className="perm-label">
        <Icon name="shield" size={13} />
        <span>
          Allow <b>{p.toolName}</b>?
        </span>
      </div>
      <pre className="perm-input nowheel">{short(toolSummary(p.toolName, p.input) || JSON.stringify(p.input, null, 2))}</pre>
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
}

/**
 * One circle per thread, floating above its first card and joined to it by a short line.
 * Click it when the thread is finished: it fills with a green tick and the whole thread fades back.
 */
function ThreadDone({ node }: { node: TurnNode }) {
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
  const lessons = node.lessons ?? [];
  const summary = live ? '' : lastText(node);

  const root = !node.parentId;
  if (far)
    return (
      <>
      {root && <ThreadDone node={node} />}
      <div className={`turn far status-${node.status} ${isTarget ? 'target' : ''} ${dim}`} style={{ ['--branch' as any]: color }}>
        <Handle type="target" position={Position.Top} />
        <div className="far-status">
          <StatusDot status={node.status} />
          {STATUS_LABEL[node.status]}
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
    {root && <ThreadDone node={node} />}
    <div className={`turn status-${node.status} ${isTarget ? 'target' : ''} ${isFresh(node.createdAt) ? 'fresh' : ''} ${dim}`} style={{ ['--branch' as any]: color }}>
      <Handle type="target" position={Position.Top} />
      {live && <div className="turn-progress" />}
      <div className="turn-head">
        {!node.completed && <StatusDot status={node.status} />}
        <span className="status-label">{node.completed ? 'Completed' : STATUS_LABEL[node.status]}</span>
        <span className="spacer" />
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
        <div className="turn-body nowheel">
          {tools.map((e) => (
            <ToolLine key={e.id} e={e} cwd={branch?.cwd} />
          ))}
        </div>
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
    </>
  );
});

export interface NoteData extends Record<string, unknown> {
  node: NoteNode;
}

/** Renders a note: checklists you can tick, bullets, headings and **bold**. */
function NoteText({ text, onToggle }: { text: string; onToggle: (line: number) => void }) {
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
  const tasks = text.match(/^\s*[-*] \[( |x|X)\]/gm) ?? [];
  const doneCount = tasks.filter((t) => /\[(x|X)\]/.test(t)).length;

  return (
    <div
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
        <button className="note-tool nodrag" title="Delete note" aria-label="Delete note" onClick={() => send({ type: 'deleteNodes', ids: [node.id] })}>
          <Icon name="trash" size={12} />
        </button>
      </div>
      {editing ? (
        <textarea
          ref={area}
          className="nodrag nowheel"
          value={text}
          placeholder={'Write anything…\n- [ ] makes a checklist'}
          onBlur={() => {
            setEditing(false);
            commit(text);
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
        <div className="note-view nowheel" onClick={() => setEditing(true)} title="Click to edit">
          {text.trim() ? <NoteText text={text} onToggle={toggle} /> : <span className="note-placeholder">Write anything…</span>}
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
