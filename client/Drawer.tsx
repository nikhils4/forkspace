import { useEffect, useState } from 'react';
import type { TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { LessonCard } from './Learn.tsx';
import { DiffStat, Md, STATUS_LABEL, StatusDot, ToolLine, branchColor, money } from './nodes.tsx';
import { isLocalPage, request, send, toast, useStore } from './store.ts';
import { Segmented, timeAgo } from './ui.tsx';

export function Drawer({ node, onClose }: { node: TurnNode; onClose: () => void }) {
  const { branches } = useStore();
  const branch = branches[node.branchId];
  const [tab, setTab] = useState<'log' | 'diff' | 'learn'>(node.lessons?.length ? 'learn' : 'log');
  const [diff, setDiff] = useState<string | null>(null);

  useEffect(() => {
    setDiff(null);
    if (tab === 'diff') request<string>({ type: 'diff', nodeId: node.id }).then(setDiff, (e) => setDiff(`Could not load changes: ${e.message}`));
  }, [tab, node.id, node.commit]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const cmd = node.sessionId && branch ? `cd ${JSON.stringify(branch.cwd)} && claude --resume ${node.sessionId} --fork-session` : '';
  const copy = (text: string, what: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast(`${what} copied`),
      () => toast('Could not copy', 'error'),
    );

  return (
    <aside className="drawer" style={{ ['--branch' as any]: branchColor(node.branchId) }}>
      <div className="drawer-head">
        <StatusDot status={node.status} />
        <b>{STATUS_LABEL[node.status]}</b>
        <span className="faint">{timeAgo(node.finishedAt ?? node.createdAt)}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>

      <div className="drawer-scroll">
        <div className="bubble-user wide">{node.prompt}</div>

        <dl className="facts">
          <dt>Branch</dt>
          <dd className="mono">{branch?.gitBranch ?? node.branchId}</dd>
          <dt>Folder</dt>
          <dd className="mono">{branch?.cwd}</dd>
          {node.commit && (
            <>
              <dt>Checkpoint</dt>
              <dd className="mono">{node.commit.slice(0, 10)}</dd>
            </>
          )}
          <dt>Changes</dt>
          <dd>{node.diffStat?.files ? <DiffStat s={node.diffStat} /> : <span className="faint">None</span>}</dd>
          <dt>Cost</dt>
          <dd>
            {money(node.costUsd) || '…'}
            {node.durationMs ? <span className="faint"> · {Math.round(node.durationMs / 1000)}s</span> : null}
          </dd>
        </dl>

        <div className="drawer-actions">
          {isLocalPage() && (
            <button className="btn" onClick={() => send({ type: 'openEditor', nodeId: node.id })}>
              <Icon name="code" size={14} /> Open in editor
            </button>
          )}
          {cmd && (
            <button className="btn" onClick={() => copy(cmd, 'Terminal command')} title="Paste in a terminal to continue from this exact point">
              <Icon name="copy" size={14} /> Copy resume command
            </button>
          )}
          {branch?.gitBranch && (
            <button className="btn" onClick={() => copy(branch.gitBranch!, 'Branch name')}>
              <Icon name="branch" size={14} /> Copy branch
            </button>
          )}
        </div>

        <div className="drawer-tabs">
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'log', label: 'Transcript' },
              { value: 'diff', label: 'Changes' },
              { value: 'learn', label: `Concepts${node.lessons?.length ? ` · ${node.lessons.length}` : ''}` },
            ]}
          />
        </div>

        <div className="drawer-body">
          {tab === 'learn' ? (
            node.lessons?.length ? (
              node.lessons.map((l) => <LessonCard key={l.id} lesson={l} />)
            ) : (
              <div className="faint">No concepts for this step yet. Tap Explain in the chat to get one.</div>
            )
          ) : tab === 'log' ? (
            <>
              {node.events.length === 0 && <div className="faint">Nothing yet.</div>}
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
                    <div className="block-label">Input</div>
                    <pre className="pre">{JSON.stringify(e.input, null, 2)}</pre>
                    {e.result != null && (
                      <>
                        <div className="block-label">Result</div>
                        <pre className={`pre ${e.isError ? 'err' : ''}`}>{e.result}</pre>
                      </>
                    )}
                  </details>
                ),
              )}
              {node.error && <div className="error-box">{node.error}</div>}
            </>
          ) : !node.commit ? (
            <div className="faint">Changes appear once the turn finishes{branch?.worktree ? '' : ' (and only for boards that use a worktree per branch)'}.</div>
          ) : diff == null ? (
            <div className="faint">Loading…</div>
          ) : diff === '' ? (
            <div className="faint">No file changes in this turn.</div>
          ) : (
            <pre className="diff">
              {diff.split('\n').map((l, i) => (
                <div
                  key={i}
                  className={
                    l.startsWith('diff ')
                      ? 'file'
                      : /^(\+\+\+|---|index |new file mode|deleted file mode|similarity |rename )/.test(l)
                        ? 'meta-line'
                        : l.startsWith('+')
                          ? 'add'
                          : l.startsWith('-')
                            ? 'del'
                            : l.startsWith('@@')
                              ? 'hunk'
                              : ''
                  }
                >
                  {l.startsWith('diff --git') ? l.replace(/^diff --git a\/(.*) b\/.*$/, '$1') : l || ' '}
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    </aside>
  );
}
