import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Attachments } from './Shots.tsx';
import { CardComments } from './Comments.tsx';
import type { TurnNode } from '../shared/types.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import { LessonCard } from './Learn.tsx';
import { Md, STATUS_LABEL, StatusDot, ToolLine, branchColor } from './nodes.tsx';
import { isLocalPage, request, toast, useStore } from './store.ts';
import { isLive } from './tree.ts';
import { Segmented, timeAgo } from './ui.tsx';

// A step's details, calm by default: what you asked, what came of it, and one obvious next move.
// Everything technical (branch, folder, checkpoint, terminal command) sits behind ⋯ or a fold.

type Tab = 'summary' | 'steps' | 'changes';

const took = (ms?: number) => (!ms ? '' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);

export function Drawer({ node, onClose, onReply, composer }: { node: TurnNode; onClose: () => void; onReply?: (id: string) => void; composer?: ReactNode }) {
  const { branches } = useStore();
  const branch = branches[node.branchId];
  const [tab, setTab] = useState<Tab>('summary');
  const [diff, setDiff] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [long, setLong] = useState(false);
  const concepts = useRef<HTMLDivElement>(null);

  // New concepts never pull you away from what you're reading: they just appear, folded,
  // at the end. Only one you asked for (Explain) brings the Summary tab forward.
  const count = node.lessons?.length ?? 0;
  const open = (node.lessons ?? []).filter((l) => !l.reviewed);
  const seenCount = useRef(count);
  useEffect(() => {
    const newest = node.lessons?.[count - 1];
    if (count > seenCount.current && newest?.asked) {
      setTab('summary');
      setTimeout(() => concepts.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    }
    seenCount.current = count;
  }, [count]);

  useEffect(() => {
    setDiff(null);
    if (tab === 'changes') request<string>({ type: 'diff', nodeId: node.id }).then(setDiff, (e) => setDiff(`Could not load changes: ${e.message}`));
  }, [tab, node.id, node.commit]);
  // While the agent works, the changes refresh as it edits and runs things.
  const toolsDone = node.events.filter((e) => e.t === 'tool' && e.result != null).length;
  useEffect(() => {
    if (tab !== 'changes' || node.commit) return;
    const t = setTimeout(() => request<string>({ type: 'diff', nodeId: node.id }).then(setDiff, () => {}), 600);
    return () => clearTimeout(t);
  }, [toolsDone, node.status]);

  useEffect(() => {
    // Esc closes the panel, but not while you're typing in it (the first Esc just leaves the box).
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !menu && !(e.target as HTMLElement)?.closest?.('textarea, input') && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, menu]);

  const cmd = node.sessionId && branch ? `cd ${JSON.stringify(branch.cwd)} && claude --resume ${node.sessionId} --fork-session` : '';
  const copy = (text: string, what: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast(`${what} copied`),
      () => toast('Could not copy', 'error'),
    );
  const live = isLive(node);
  const isHead = branch?.headNodeId === node.id;
  const tools = node.events.filter((e) => e.t === 'tool').length;
  const final = [...node.events].reverse().find((e) => e.t === 'text' && !e.partial && e.text.trim());
  const menuItems: MenuItem[] = [
    ...(isLocalPage() ? [{ label: 'Open in editor', icon: 'code' as const, onClick: () => request<string>({ type: 'openEditor', nodeId: node.id }).then((app) => toast(`Opened in ${app}`), (e) => toast(e.message, 'error')) }] : []),
    ...(cmd ? [{ label: 'Copy resume command', icon: 'copy' as const, hint: 'Terminal', onClick: () => copy(cmd, 'Terminal command') }] : []),
    ...(branch?.gitBranch ? [{ label: 'Copy branch name', icon: 'branch' as const, onClick: () => copy(branch.gitBranch!, 'Branch name') }] : []),
    { label: 'Copy prompt', icon: 'copy', onClick: () => copy(node.prompt, 'Prompt') },
  ];

  return (
    <aside className="drawer" style={{ ['--branch' as any]: branchColor(node.branchId) }}>
      <div className="drawer-head">
        <StatusDot status={node.status} />
        <b>{node.completed ? 'Completed' : STATUS_LABEL[node.status]}</b>
        <span className="faint">
          {timeAgo(node.finishedAt ?? node.createdAt)}
          {node.durationMs ? ` · took ${took(node.durationMs)}` : ''}
        </span>
        <span className="spacer" />
        <button
          className="icon-btn"
          aria-label="More"
          title="More"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.right - 220, y: r.bottom + 6 });
          }}
        >
          <Icon name="more" />
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" />
        </button>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      <div className="drawer-scroll">
        <div className={`drawer-prompt ${long ? 'open' : ''}`} onClick={() => setLong(!long)} title={long ? '' : 'Show all'}>
          {node.prompt}
        </div>
        <Attachments list={node.attachments} label={node.prompt} />
        <CardComments node={node} roomy />

        <div className="drawer-outcome">
          {node.diffStat?.files ? (
            <span className="outcome-stat">
              <Icon name="file" size={13} /> {node.diffStat.files} file{node.diffStat.files === 1 ? '' : 's'} changed
              <span className="faint">·</span>
              <span className="add-text">+{node.diffStat.insertions}</span>
              <span className="del-text">−{node.diffStat.deletions}</span>
            </span>
          ) : (
            <span className="faint">{live ? 'Working…' : 'No file changes'}</span>
          )}
          <span className="spacer" />
          {!live && node.sessionId && onReply && (
            <button className="btn sm primary" onClick={() => onReply(node.id)}>
              <Icon name={isHead ? 'chat' : 'branch'} size={13} /> {isHead ? 'Reply' : 'Branch from here'}
            </button>
          )}
        </div>

        <div className="drawer-tabs">
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            options={[
              { value: 'summary', label: 'Summary' },
              { value: 'steps', label: `Steps${tools ? ` · ${tools}` : ''}` },
              { value: 'changes', label: 'Changes' },
            ]}
          />
        </div>

        <div className="drawer-body">
          {tab === 'summary' && (
            <>
              {final && final.t === 'text' ? <Md text={final.text} /> : <div className="faint">{live ? 'The agent is still working.' : 'The agent finished without a message.'}</div>}
              {node.error && <div className="error-box">{node.error}</div>}
              <div ref={concepts} className="drawer-section">
                <div className="drawer-label">
                  <span className="mentor-orb small" /> Concepts in this step
                </div>
                {open.length ? (
                  open.map((l, i) => <LessonCard key={l.id} lesson={l} compact={i > 0} review />)
                ) : count ? (
                  <div className="faint small">You've reviewed the concepts from this step. They're in Concepts.</div>
                ) : (
                  <div className="faint small">None yet. Right-click the card and choose Explain this step.</div>
                )}
              </div>
              <details className="drawer-tech">
                <summary>Technical details</summary>
                <dl className="facts">
                  <dt>Branch</dt>
                  <dd className="mono">{branch?.gitBranch ?? node.branchId}</dd>
                  <dt>Folder</dt>
                  <dd className="mono">{branch?.cwd}</dd>
                  {node.commit && (
                    <>
                      <dt>Commit</dt>
                      <dd>
                        <span className="mono">{node.commit.slice(0, 8)}</span> {node.commitMessage}
                      </dd>
                    </>
                  )}
                </dl>
              </details>
            </>
          )}

          {tab === 'steps' && (
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
            </>
          )}

          {tab === 'changes' &&
            (!node.baseCommit ? (
              <div className="faint">{node.imported ? 'This step ran in Claude Code before it came into Forkspace, so its changes were not recorded.' : 'Changes are shown for projects in git. This folder is not one.'}</div>
            ) : diff == null ? (
              <div className="faint">Loading…</div>
            ) : diff === '' ? (
              <div className="faint">{live ? 'No files changed yet. They show up here as the agent edits.' : "This step didn't change any files. It only read code or ran commands."}</div>
            ) : (
              <>
              {!node.commit && <div className="faint small diff-live">{live ? 'Live: updates as the agent works.' : 'Not saved as a checkpoint yet. This is the folder as it is now.'}</div>}
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
              </>
            ))}
        </div>
      </div>
      {composer && <div className="drawer-composer">{composer}</div>}
    </aside>
  );
}
