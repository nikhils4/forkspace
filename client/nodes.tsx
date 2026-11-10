import { Handle, NodeResizer, Position, type NodeProps } from '@xyflow/react';
import { memo, useEffect, useRef, useState } from 'react';
import type { NoteNode, PendingPermission, TurnEvent, TurnNode } from '../shared/types.ts';
import { send, useStore } from './store.ts';

export const NOTE_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#e5e7eb'];

export const BRANCH_COLORS = ['#7c9cff', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#22d3ee', '#fb7185', '#a3e635'];
export function branchColor(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BRANCH_COLORS[h % BRANCH_COLORS.length];
}

export const STATUS_LABEL: Record<TurnNode['status'], string> = {
  running: 'Running',
  waiting: 'Needs you',
  done: 'Done',
  error: 'Error',
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

/** Tiny, safe markdown: fenced code, inline code, bold. No HTML injection. */
export function Md({ text, partial }: { text: string; partial?: boolean }) {
  const parts = text.split(/```[^\n]*\n?/);
  return (
    <div className={`text ${partial ? 'partial' : ''}`}>
      {parts.map((p, i) =>
        i % 2 ? (
          <pre key={i} className="code">
            {p.replace(/\n$/, '')}
          </pre>
        ) : (
          <span key={i}>
            {p.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((t, j) =>
              t.startsWith('`') && t.endsWith('`') && t.length > 2 ? (
                <code key={j}>{t.slice(1, -1)}</code>
              ) : t.startsWith('**') && t.endsWith('**') && t.length > 4 ? (
                <b key={j}>{t.slice(2, -2)}</b>
              ) : (
                t
              ),
            )}
          </span>
        ),
      )}
    </div>
  );
}


export function ToolLine({ e, cwd }: { e: Extract<TurnEvent, { t: 'tool' }>; cwd?: string }) {
  const state = e.result == null ? 'pending' : e.isError ? 'err' : 'ok';
  const arg = toolSummary(e.name, e.input);
  return (
    <div className={`tool-line ${state}`}>
      <span className="tool-mark">{state === 'pending' ? '◌' : state === 'err' ? '✕' : '✓'}</span>
      <span className="tool-name">{e.name}</span>
      <span className="tool-arg" title={arg}>
        {cwd ? arg.split(cwd + '/').join('').split(cwd).join('.') : arg}
      </span>
    </div>
  );
}

function Permission({ node, p }: { node: TurnNode; p: PendingPermission }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const reply = (decision: 'allow' | 'always' | 'deny', extra?: object) =>
    send({ type: 'permission', nodeId: node.id, requestId: p.requestId, decision, ...extra });

  const questions = p.toolName === 'AskUserQuestion' && Array.isArray((p.input as any).questions) ? ((p.input as any).questions as any[]) : null;
  if (questions)
    return (
      <div className="perm nodrag">
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
            Answer
          </button>
          <button className="btn" onClick={() => reply('deny', { message: 'The user skipped the question.' })}>
            Skip
          </button>
        </div>
      </div>
    );

  return (
    <div className="perm nodrag">
      <div className="perm-title">
        Allow <b>{p.toolName}</b>?
      </div>
      <pre className="perm-input nowheel">{toolSummary(p.toolName, p.input) || JSON.stringify(p.input, null, 2)}</pre>
      <div className="perm-actions">
        <button className="btn primary" onClick={() => reply('allow')}>
          Allow
        </button>
        {p.canAlways && (
          <button className="btn" onClick={() => reply('always')}>
            Always
          </button>
        )}
        <button className="btn danger" onClick={() => reply('deny')}>
          Deny
        </button>
      </div>
    </div>
  );
}

export interface TurnData extends Record<string, unknown> {
  node: TurnNode;
  onOpen: (id: string) => void;
  onReply: (id: string) => void;
  isTarget: boolean;
}

export const TurnCard = memo(function TurnCard({ data, selected }: NodeProps & { data: TurnData }) {
  const { node, onOpen, onReply, isTarget } = data;
  const { branches } = useStore();
  const branch = branches[node.branchId];
  const color = branchColor(node.branchId);
  const bodyRef = useRef<HTMLDivElement>(null);
  const live = node.status === 'running' || node.status === 'waiting';

  // Follow the output while it streams.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && live) el.scrollTop = el.scrollHeight;
  }, [node.events, live]);

  const isHead = branch?.headNodeId === node.id;

  return (
    <div className={`turn status-${node.status} ${selected ? 'selected' : ''} ${isTarget ? 'target' : ''}`} style={{ ['--branch' as any]: color }}>
      <Handle type="target" position={Position.Top} />
      <div className="turn-head">
        <span className={`dot ${node.status}`} />
        <span className="status-label">{STATUS_LABEL[node.status]}</span>
        <span className="branch-tag" title={branch?.gitBranch ?? 'branch'}>
          {branch?.gitBranch ?? `branch ${node.branchId.slice(0, 4)}`}
        </span>
        <span className="spacer" />
        {node.costUsd != null && <span className="muted">{money(node.costUsd)}</span>}
      </div>

      <div className="prompt">{node.prompt}</div>

      <div className="body nowheel" ref={bodyRef}>
        {node.events.length === 0 && live && <div className="muted thinking">Thinking…</div>}
        {node.events.map((e, i) =>
          e.t === 'text' ? (
            <Md key={i} text={e.text} partial={e.partial} />
          ) : e.t === 'tool' ? (
            <ToolLine key={i} e={e} cwd={branch?.cwd} />
          ) : null,
        )}
        {node.error && <div className="error-box">{node.error}</div>}
      </div>

      {node.pending && <Permission node={node} p={node.pending} />}

      <div className="turn-foot nodrag">
        {node.diffStat && node.diffStat.files > 0 ? (
          <span className="diffstat">
            {node.diffStat.files} file{node.diffStat.files === 1 ? '' : 's'} <span className="add">+{node.diffStat.insertions}</span>{' '}
            <span className="del">−{node.diffStat.deletions}</span>
          </span>
        ) : (
          <span className="muted">{node.status === 'done' ? 'No file changes' : ''}</span>
        )}
        <span className="spacer" />
        <button className="btn ghost" onClick={() => onOpen(node.id)}>
          Open
        </button>
        {live ? (
          <button className="btn danger" onClick={() => send({ type: 'stop', nodeId: node.id })}>
            Stop
          </button>
        ) : (
          node.sessionId && (
            <button className="btn" onClick={() => onReply(node.id)} title={isHead ? 'Continue this branch' : 'Start a new branch from here'}>
              {isHead ? 'Reply' : 'Fork'}
            </button>
          )
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});

export interface NoteData extends Record<string, unknown> {
  node: NoteNode;
}

export const NoteCard = memo(function NoteCard({ data, selected }: NodeProps & { data: NoteData }) {
  const { node } = data;
  const [text, setText] = useState(node.text);
  const timer = useRef<number | undefined>(undefined);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setText(node.text);
  }, [node.text]);

  const save = (patch: Partial<NoteNode>) => send({ type: 'upsertNote', note: { ...node, ...patch } });

  return (
    <div className={`note ${selected ? 'selected' : ''}`} style={{ background: node.color }}>
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={90}
        onResizeEnd={(_, p) => send({ type: 'move', moves: [{ id: node.id, position: { x: p.x, y: p.y }, width: p.width, height: p.height }] })}
      />
      <Handle type="target" position={Position.Top} />
      <div className="note-bar">
        {NOTE_COLORS.map((c) => (
          <button key={c} className="swatch nodrag" style={{ background: c }} onClick={() => save({ color: c })} aria-label="Note colour" />
        ))}
      </div>
      <textarea
        className="nodrag nowheel"
        value={text}
        placeholder="Write anything…"
        onFocus={() => (editing.current = true)}
        onBlur={() => {
          editing.current = false;
          if (text !== node.text) save({ text });
        }}
        onChange={(e) => {
          setText(e.target.value);
          clearTimeout(timer.current);
          const v = e.target.value;
          timer.current = window.setTimeout(() => save({ text: v }), 600);
        }}
      />
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
});
