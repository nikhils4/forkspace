import { CardComments } from './Comments.tsx';
import { ToolDiff, editsOf } from './ToolDiff.tsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Attachments } from './Shots.tsx';
import type { TurnNode } from '../shared/types.ts';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { Icon } from './icons.tsx';
import { NoteBar, openThreadNote } from './ThreadNotes.tsx';
import { LiveLine, Md, STATUS_LABEL, StatusDot, ToolLine, branchColor } from './nodes.tsx';
import { isLocalPage, openTerminalFor, request, toast, useStore } from './store.ts';
import { isLive, isTurn } from './tree.ts';
import { StepPullHint, useStepPull } from './stepPull.tsx';
import { timeAgo } from './ui.tsx';

// A step's details, calm by default: what you asked, what came of it, and one obvious next move.
// Everything technical (branch, folder, checkpoint, terminal command) sits behind ⋯ or a fold.

/** A diff split per file, with counts. */
function parseDiff(text: string) {
  const out: { path: string; add: number; del: number; isNew: boolean; lines: string[] }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (const l of text.split('\n')) {
    const m = l.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (m) {
      cur = { path: m[2], add: 0, del: 0, isNew: false, lines: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^new file mode/.test(l)) cur.isNew = true;
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity |rename |old mode|new mode)/.test(l)) continue;
    if (l.startsWith('+')) cur.add++;
    else if (l.startsWith('-')) cur.del++;
    cur.lines.push(l);
  }
  return out;
}

const took = (ms?: number) => (!ms ? '' : ms < 60000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);

export function Drawer({ node, onClose, onReply, onGo, composer }: { node: TurnNode; onClose: () => void; onReply?: (id: string) => void; onGo?: (id: string) => void; composer?: ReactNode }) {
  const { branches, nodes } = useStore();
  const branch = branches[node.branchId];
  const [diff, setDiff] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [long, setLong] = useState(false);
  useEffect(() => {
    setDiff(null);
    request<string>({ type: 'diff', nodeId: node.id }).then(setDiff, () => setDiff(''));
  }, [node.id, node.commit]);
  // While the agent works, the changes refresh as it edits and runs things.
  const toolsDone = node.events.filter((e) => e.t === 'tool' && e.result != null).length;
  useEffect(() => {
    if (node.commit) return;
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
    { label: 'Terminal here', icon: 'terminal' as const, hint: 'This card’s folder', onClick: () => openTerminalFor(node.branchId) },
    ...(cmd ? [{ label: 'Copy resume command', icon: 'copy' as const, hint: 'Terminal', onClick: () => copy(cmd, 'Terminal command') }] : []),
    ...(branch?.gitBranch ? [{ label: 'Copy branch name', icon: 'branch' as const, onClick: () => copy(branch.gitBranch!, 'Branch name') }] : []),
    { label: 'Copy prompt', icon: 'copy', onClick: () => copy(node.prompt, 'Prompt') },
    'sep',
    ...(branch?.note?.markdown || branch?.note?.busy ? [{ label: 'Thread notes', icon: 'note' as const, onClick: () => openThreadNote(node.branchId) }] : []),
    ...(branch
      ? [
          {
            label: 'Copy folder path',
            icon: 'folder' as const,
            hint: node.commit ? node.commit.slice(0, 7) : undefined,
            onClick: () => copy(branch.cwd, 'Folder path'),
          },
        ]
      : []),
  ];

  // Where this step sits: its thread and its place in it.
  const path: TurnNode[] = [];
  for (let t: TurnNode | undefined = node; t; t = t.parentId ? (nodes[t.parentId] as TurnNode | undefined) : undefined) path.unshift(t);

  // Scroll hard past the top: the step above in this thread; past the bottom: the step after
  // (on this branch if it goes on, else the newest reply). The panel slides, the canvas follows.
  const prev = path.length > 1 ? path[path.length - 2] : undefined;
  const kids = Object.values(nodes).filter((n): n is TurnNode => isTurn(n) && n.parentId === node.id);
  const next = kids.find((k) => k.branchId === node.branchId) ?? kids.sort((a, b) => b.createdAt - a.createdAt)[0];
  const scroller = useRef<HTMLDivElement>(null);
  const [slide, setSlide] = useState<'' | 'out-up' | 'out-down' | 'in-up' | 'in-down'>('');
  const arriving = useRef<'up' | 'down' | null>(null);
  const pull = useStepPull(scroller, onGo && prev, onGo && next, (target, dir) => {
    setSlide(dir === 'up' ? 'out-up' : 'out-down');
    arriving.current = dir;
    setTimeout(() => onGo?.(target.id), 170);
  });
  useEffect(() => {
    if (!arriving.current) return;
    const dir = arriving.current;
    arriving.current = null;
    if (scroller.current) scroller.current.scrollTop = 0;
    setSlide(dir === 'up' ? 'in-up' : 'in-down');
    const t = setTimeout(() => setSlide(''), 380);
    return () => clearTimeout(t);
  }, [node.id]);
  const threadName = path[0]?.title || path[0]?.prompt || '';
  const files = parseDiff(diff ?? '');
  const working = isLive(node);

  return (
    <aside className="drawer v2" style={{ ['--branch' as any]: branchColor(node.branchId) }}>
      <div className="drawer-head">
        <div className="dh-main">
          <div className="dh-where" title={threadName}>
            <span className="ellipsis">{threadName}</span>
            {path.length > 1 && <span className="dh-step">step {path.length}</span>}
          </div>
          <div className="dh-status">
            <StatusDot status={node.status} />
            {working ? <LiveLine node={node} /> : <b>{node.completed ? 'Completed' : STATUS_LABEL[node.status]}</b>}
            <span className="faint">
              {timeAgo(node.finishedAt ?? node.createdAt)}
              {node.durationMs ? ` · ${took(node.durationMs)}` : ''}
            </span>
          </div>
        </div>
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

      <div className={`drawer-scroll ${slide ? `slide-${slide}` : ''}`} ref={scroller}>
        <StepPullHint pull={pull} dir="up" target={onGo && prev} step={path.length - 1} />
        <div className="ds ds-note">
          <NoteBar branchId={node.branchId} />
        </div>
        <section className="ds">
          <div className="ds-label">You asked</div>
          <div className={`drawer-prompt ${long ? 'open' : ''}`} onClick={() => setLong(!long)} title={long ? '' : 'Show all'}>
            {node.prompt}
          </div>
          <Attachments list={node.attachments} label={node.prompt} />
        </section>

        {!!node.comments?.length && (
          <section className="ds">
            <div className="ds-label">
              Your comments
              <span className="ds-meta">only you see these</span>
            </div>
            <CardComments node={node} roomy />
          </section>
        )}

        <section className="ds">
          <div className="ds-label">Answer</div>
          {final && final.t === 'text' ? (
            <Md text={final.text} />
          ) : (
            <div className="ds-quiet">{working ? 'Working on it. The answer shows up here.' : 'The agent finished without a message.'}</div>
          )}
          {node.error && <div className="error-box">{node.error}</div>}
        </section>

        <section className="ds">
          <div className="ds-label">
            What changed
            {files.length > 0 && (
              <span className="ds-meta">
                {files.length} file{files.length === 1 ? '' : 's'} <span className="add-text">+{files.reduce((a, f) => a + f.add, 0)}</span> <span className="del-text">−{files.reduce((a, f) => a + f.del, 0)}</span>
                {!node.commit && <em>{working ? ' · live' : ' · not saved yet'}</em>}
              </span>
            )}
          </div>
          {!node.baseCommit ? (
            <div className="ds-quiet">{node.imported ? 'Made in Claude Code before it came here, so changes weren’t recorded.' : 'Changes show for projects in git.'}</div>
          ) : diff == null ? (
            <div className="ds-quiet">Loading…</div>
          ) : !files.length ? (
            <div className="ds-none">
              <Icon name="check" size={13} />
              {working ? 'Nothing changed yet' : tools ? 'No files changed. It only looked around.' : 'No files changed.'}
            </div>
          ) : (
            <div className="file-list">
              {files.map((f) => (
                <details key={f.path} className="file-row">
                  <summary>
                    <Icon name="chevronRight" size={12} className="fr-caret" />
                    <span className="fr-name ellipsis" title={f.path}>
                      <b>{f.path.split('/').pop()}</b>
                      {f.path.includes('/') && <span className="faint"> {f.path.slice(0, f.path.lastIndexOf('/'))}</span>}
                    </span>
                    {f.isNew && <span className="fr-tag">new</span>}
                    <span className="add-text">+{f.add}</span>
                    <span className="del-text">−{f.del}</span>
                  </summary>
                  <pre className="diff">
                    {f.lines.map((l, i) => (
                      <div key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
                        {l || ' '}
                      </div>
                    ))}
                  </pre>
                </details>
              ))}
            </div>
          )}
        </section>

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
                      <>
                        <div className="block-label">Change</div>
                        <ToolDiff e={e} cwd={branch?.cwd} />
                      </>
                    ) : (
                      <>
                        <div className="block-label">Input</div>
                        <pre className="pre">{JSON.stringify(e.input, null, 2)}</pre>
                      </>
                    )}
                    {e.result != null && (
                      <>
                        <div className="block-label">Result</div>
                        <pre className={`pre ${e.isError ? 'err' : ''}`}>{e.result}</pre>
                      </>
                    )}
                  </details>
                ),
              )}
            </div>
          </details>
        )}
        <StepPullHint pull={pull} dir="down" target={onGo && next} step={path.length + 1} />
      </div>
      {composer && <div className="drawer-composer">{composer}</div>}
    </aside>
  );
}
