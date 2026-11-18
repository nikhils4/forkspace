import { useMemo, useState } from 'react';
import type { Branch, PrInfo, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { branchColor } from './nodes.tsx';
import { useReady } from './review.ts';
import { STAGES, STAGE_LABEL, prStage, sendFix, threadsOf, type Stage, type ThreadRow } from './status.ts';
import { request, toast, useStore } from './store.ts';
import { timeAgo, useTick } from './ui.tsx';

export function StageChip({ stage, small }: { stage: Stage; small?: boolean }) {
  return <span className={`st-chip st-${stage} ${small ? 'sm' : ''}`}>{STAGE_LABEL[stage]}</span>;
}
export const StageDot = ({ stage }: { stage: Stage }) => <span className={`st-dot st-${stage}`} title={STAGE_LABEL[stage]} />;

/** "#12" plus what's open on it: failing checks, bug reports, comments. */
export function PrBadge({ pr }: { pr: PrInfo }) {
  const s = prStage(pr);
  const bits = [
    (pr.checks?.failing ?? 0) > 0 && `${pr.checks!.failing} failing`,
    (pr.bugs ?? 0) > 0 && `${pr.bugs} bug${pr.bugs === 1 ? '' : 's'}`,
    (pr.comments ?? 0) > 0 && `${pr.comments} comment${pr.comments === 1 ? '' : 's'}`,
    pr.conflicts && 'conflicts',
  ].filter(Boolean);
  return (
    <a className={`pr-badge ${s ? `st-${s}` : ''}`} href={pr.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title={`${pr.title ?? 'Pull request'}${bits.length ? ` · ${bits.join(', ')}` : ''}`}>
      <Icon name="branch" size={10} />#{pr.number}
      {bits.length > 0 && <span className="pr-bits">{bits.length === 1 ? bits[0] : `${bits.length} open`}</span>}
    </a>
  );
}

const ACTIVE = (s: Stage) => s !== 'done' && s !== 'merged';

/** Desktop sidebar: the board's threads, each with its branches, and where each one stands. */
export function SidebarThreads({ boardId, current, onGo }: { boardId: string; current?: string | null; onGo: (t: TurnNode) => void }) {
  useTick();
  const { nodes, branches, boards } = useStore();
  const ready = useReady();
  const threads = useMemo(() => threadsOf(nodes, branches, boards, ready, boardId), [nodes, branches, boards, ready, boardId]);
  const [showDone, setShowDone] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!threads.length) return <div className="side-empty">No threads yet</div>;
  const active = threads.filter((t) => ACTIVE(t.stage) && !t.root.completed);
  const done = threads.filter((t) => !active.includes(t));
  const currentBranch = current ? nodes[current] && (nodes[current] as TurnNode).branchId : undefined;
  const row = (t: ThreadRow) => {
    const forks = t.branches.length > 1;
    const open = forks && !closed.has(t.root.id);
    return (
      <div key={t.root.id} className={`th ${t.branches.some((b) => b.branchId === currentBranch) ? 'on' : ''}`}>
        <button className="th-main" onClick={() => onGo(t.branches[0].last)} title={t.title}>
          {forks ? (
            <span
              className={`th-caret ${open ? 'open' : ''}`}
              role="button"
              aria-label={open ? 'Hide branches' : 'Show branches'}
              onClick={(e) => {
                e.stopPropagation();
                const next = new Set(closed);
                open ? next.add(t.root.id) : next.delete(t.root.id);
                setClosed(next);
              }}
            >
              <Icon name="chevronRight" size={11} />
            </span>
          ) : (
            <StageDot stage={t.stage} />
          )}
          <span className="th-title ellipsis">{t.title}</span>
          {forks && !open ? <StageDot stage={t.stage} /> : !forks && t.branches[0].branch?.pr ? <PrBadge pr={t.branches[0].branch.pr} /> : null}
        </button>
        {open &&
          t.branches.map((b) => (
            <button key={b.branchId} className={`th-branch ${b.branchId === currentBranch ? 'on' : ''}`} onClick={() => onGo(b.last)} title={`${b.label} · ${STAGE_LABEL[b.stage]}`} style={{ ['--branch' as any]: branchColor(b.branchId) }}>
              <span className="th-line" />
              <StageDot stage={b.stage} />
              <span className="ellipsis">{b.label}</span>
              {b.branch?.pr && <PrBadge pr={b.branch.pr} />}
            </button>
          ))}
      </div>
    );
  };
  return (
    <div className="threads">
      {active.map(row)}
      {!active.length && <div className="side-empty">Nothing active on this board</div>}
      {done.length > 0 && (
        <>
          <button className="th-fold" onClick={() => setShowDone(!showDone)}>
            <Icon name="chevronRight" size={11} className={showDone ? 'open' : ''} /> Done and merged · {done.length}
          </button>
          {showDone && done.map(row)}
        </>
      )}
    </div>
  );
}

/** Every thread on every board, grouped by where it stands. */
export function WorkPage({ onGo }: { onGo: (t: TurnNode) => void }) {
  useTick();
  const { nodes, branches, boards } = useStore();
  const ready = useReady();
  const threads = useMemo(() => threadsOf(nodes, branches, boards, ready), [nodes, branches, boards, ready]);
  const [showDone, setShowDone] = useState(false);
  // A thread shows once per branch stage that needs attention, so a fork with failing checks
  // isn't hidden behind a main line that's fine.
  const groups = new Map<Stage, { t: ThreadRow; b: ThreadRow['branches'][number] }[]>();
  for (const t of threads)
    for (const b of t.branches) {
      const s = t.root.completed && ACTIVE(b.stage) && b.stage !== 'needs' && b.stage !== 'working' ? 'done' : b.stage;
      groups.set(s, [...(groups.get(s) ?? []), { t, b }]);
    }
  const shown = STAGES.filter((s) => groups.get(s)?.length && (showDone || ACTIVE(s)));
  const doneCount = (groups.get('done')?.length ?? 0) + (groups.get('merged')?.length ?? 0);
  return (
    <div className="work">
      <div className="work-summary">
        {STAGES.filter((s) => ACTIVE(s) && groups.get(s)?.length).map((s) => (
          <a key={s} href={`#work-${s}`} className={`work-count st-${s}`}>
            <b>{groups.get(s)!.length}</b> {STAGE_LABEL[s]}
          </a>
        ))}
        {!threads.length && <div className="empty-note">No threads yet.</div>}
      </div>
      {shown.map((s) => (
        <section key={s} id={`work-${s}`} className="work-group">
          <div className={`work-head st-${s}`}>
            <StageDot stage={s} /> {STAGE_LABEL[s]} <span className="faint">· {groups.get(s)!.length}</span>
          </div>
          {groups.get(s)!.map(({ t, b }) => (
            <WorkRow key={b.branchId} t={t} b={b} onGo={onGo} />
          ))}
        </section>
      ))}
      {doneCount > 0 && (
        <button className="th-fold" onClick={() => setShowDone(!showDone)}>
          <Icon name="chevronRight" size={11} className={showDone ? 'open' : ''} /> {showDone ? 'Hide' : 'Show'} done and merged · {doneCount}
        </button>
      )}
    </div>
  );
}

function WorkRow({ t, b, onGo }: { t: ThreadRow; b: ThreadRow['branches'][number]; onGo: (t: TurnNode) => void }) {
  const { nodes } = useStore();
  const pr = b.branch?.pr;
  const fixable = pr && (pr.items?.length ?? 0) > 0 && pr.state === 'OPEN';
  const forks = t.branches.length > 1;
  return (
    <div className="work-row" style={{ ['--branch' as any]: branchColor(b.branchId) }}>
      <button className="work-main" onClick={() => onGo(b.last)}>
        <span className="work-where">
          {t.board?.name} · {timeAgo(b.at)}
          {b.steps > 1 && ` · ${b.steps} steps`}
        </span>
        <span className="work-title">
          {t.title}
          {forks && b.branchId !== t.root.branchId && <span className="work-fork"> ↳ {b.label}</span>}
        </span>
        {b.last && <span className="work-now ellipsis">{b.stage === 'working' || b.stage === 'needs' || !pr?.items?.length ? t.now : pr.items.map((i) => i.title).slice(0, 2).join(' · ')}</span>}
      </button>
      <div className="work-side">
        {pr && <PrBadge pr={pr} />}
        {fixable && (
          <button className="btn xs" onClick={() => sendFix(nodes, b.last, pr!)} title="Send every open check, bug and comment to the agent as the next step">
            <Icon name="spark" size={11} /> Fix these
          </button>
        )}
      </div>
    </div>
  );
}

/** Details panel: the branch's pull request, what's still open on it, and "Fix these". */
export function PrSection({ branch, last }: { branch: Branch; last: TurnNode }) {
  const { nodes } = useStore();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  const pr = branch.pr;
  const call = async (msg: object) => {
    setBusy(true);
    try {
      await request(msg as any);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!pr && !linking)
    return (
      <button className="linkish pr-add" onClick={() => setLinking(true)}>
        <Icon name="branch" size={12} /> Link a pull request
      </button>
    );
  if (!pr)
    return (
      <section className="ds ds-pr">
        <div className="ds-label">
          Pull request <span className="ds-meta">found on its own when the agent opens one</span>
        </div>
        <form
          className="pr-link"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) call({ type: 'linkPr', branchId: branch.id, url: url.trim() }).then(() => setUrl(''));
          }}
        >
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a GitHub PR link" />
          <button className="btn sm" disabled={!url.trim() || busy}>
            Link
          </button>
        </form>
      </section>
    );
  const s = prStage(pr);
  const items = pr.items ?? [];
  return (
    <section className="ds ds-pr">
      <div className="ds-label">
        Pull request
        <span className="ds-meta">{pr.checkedAt ? `checked ${timeAgo(pr.checkedAt)}` : 'reading…'}</span>
      </div>
      <div className="pr-head">
        <a href={pr.url} target="_blank" rel="noreferrer" className="pr-title">
          #{pr.number} {pr.title ?? ''}
        </a>
        {s && <StageChip stage={s} small />}
      </div>
      {pr.error && <div className="ds-quiet">Couldn’t read it: {pr.error}</div>}
      {pr.checks && (
        <div className="pr-counts">
          <span className={pr.checks.failing ? 'bad' : ''}>{pr.checks.failing} failing</span>
          <span>{pr.checks.pending} running</span>
          <span>{pr.checks.passing} passed</span>
          <span className={pr.bugs ? 'bad' : ''}>
            {pr.bugs ?? 0} bug{pr.bugs === 1 ? '' : 's'}
          </span>
          <span className={pr.comments ? 'warn' : ''}>
            {pr.comments ?? 0} comment{pr.comments === 1 ? '' : 's'}
          </span>
        </div>
      )}
      {s === 'ready' && (
        <div className="pr-ready">
          <Icon name="check" size={13} /> Nothing open. Ready to merge.
        </div>
      )}
      {items.length > 0 && (
        <ul className="pr-items">
          {items.map((it, i) => (
            <li key={i} className={`pr-item k-${it.kind}`}>
              <span className="pr-kind">{it.kind === 'check' ? 'Check' : it.kind === 'bug' ? 'Bug' : it.kind === 'conflict' ? 'Conflict' : it.kind === 'changes' ? 'Review' : 'Comment'}</span>
              <span className="pr-text">
                {it.url ? (
                  <a href={it.url} target="_blank" rel="noreferrer">
                    {it.title}
                  </a>
                ) : (
                  it.title
                )}
                {it.path && (
                  <span className="faint">
                    {' '}
                    {it.path.split('/').pop()}
                    {it.line ? `:${it.line}` : ''}
                  </span>
                )}
                {it.who && <span className="faint"> · {it.who}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="pr-actions">
        {items.length > 0 && pr.state === 'OPEN' && (
          <button className="btn primary sm" onClick={() => sendFix(nodes, last, pr)} title="Send every open item to the agent as the next step on this branch">
            <Icon name="spark" size={12} /> Fix these
          </button>
        )}
        <button className="btn ghost sm" disabled={busy} onClick={() => call({ type: 'refreshPr', branchId: branch.id })}>
          {busy ? <span className="spinner" /> : <Icon name="refresh" size={12} />} Check now
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={() => call({ type: 'linkPr', branchId: branch.id, url: null })}>
          Unlink
        </button>
      </div>
    </section>
  );
}
