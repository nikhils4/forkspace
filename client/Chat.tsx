import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Attachments } from './Shots.tsx';
import { NoteBar } from './ThreadNotes.tsx';
import type { Board, TurnEvent, TurnNode } from '../shared/types.ts';
import { composerFocus } from './Composer.tsx';
import { Icon } from './icons.tsx';
import { DiffStat, Md, Permission, STATUS_LABEL, StatusDot, ToolLine, branchColor, isFresh, money } from './nodes.tsx';
import { request, send, toast, useStore } from './store.ts';
import { childrenOf, currentActivity, isLive, lastText, latestLeaf, leaves, pathTo, turnsOf } from './tree.ts';
import { timeAgo, useTick } from './ui.tsx';

type Group = { kind: 'text'; e: Extract<TurnEvent, { t: 'text' }> } | { kind: 'tools'; items: Extract<TurnEvent, { t: 'tool' }>[] };

function group(events: TurnEvent[]): Group[] {
  const out: Group[] = [];
  for (const e of events) {
    if (e.t === 'text') out.push({ kind: 'text', e });
    else if (e.t === 'tool') {
      const last = out[out.length - 1];
      if (last?.kind === 'tools') last.items.push(e);
      else out.push({ kind: 'tools', items: [e] });
    }
  }
  return out;
}

function Tools({ items, live, cwd }: { items: Extract<TurnEvent, { t: 'tool' }>[]; live: boolean; cwd?: string }) {
  const [open, setOpen] = useState(false);
  const show = open || live;
  const names = [...new Set(items.map((i) => i.name))].slice(0, 4).join(', ');
  const failed = items.filter((i) => i.isError).length;
  return (
    <div className={`tools ${show ? 'open' : ''}`}>
      <button className="tools-head" onClick={() => setOpen(!open)}>
        <Icon name="chevronRight" size={13} className="chev" />
        <span>
          {items.length} step{items.length === 1 ? '' : 's'}
        </span>
        <span className="faint ellipsis">{names}</span>
        {failed > 0 && <span className="tools-failed">{failed} failed</span>}
      </button>
      {show && (
        <div className="tools-list">
          {items.map((e) => (
            <ToolLine key={e.id} e={e} cwd={cwd} />
          ))}
        </div>
      )}
    </div>
  );
}

function Turn({ t, isLast, forkHere, openDetails }: { t: TurnNode; isLast: boolean; forkHere: () => void; openDetails: () => void }) {
  const { branches } = useStore();
  const cwd = branches[t.branchId]?.cwd;
  const live = isLive(t);
  const groups = group(t.events);
  return (
    <div className={`msg-pair ${isFresh(t.createdAt) ? 'fresh' : ''}`} style={{ ['--branch' as any]: branchColor(t.branchId) }}>
      <div className="bubble-user">
        {t.prompt}
        <Attachments list={t.attachments} label={t.prompt} />
      </div>
      <div className={`msg-agent status-${t.status}`}>
        <div className="msg-rail" />
        <div className="msg-content">
          {groups.length === 0 && live && <div className="faint shimmer-text">Thinking…</div>}
          {groups.map((g, i) =>
            g.kind === 'text' ? (
              <Md key={i} text={g.e.text} partial={g.e.partial} />
            ) : (
              <Tools key={i} items={g.items} live={live && i === groups.length - 1} cwd={cwd} />
            ),
          )}
          {t.error && <div className="error-box">{t.error}</div>}
          {t.pending && <Permission node={t} p={t.pending} />}
          <div className="msg-meta">
            <StatusDot status={t.status} />
            <span className="meta-status">{STATUS_LABEL[t.status]}</span>
            <DiffStat s={t.diffStat} />
            <span className="spacer" />
            {live ? (
              <button className="btn danger-ghost xs" onClick={() => send({ type: 'stop', nodeId: t.id })}>
                <Icon name="stop" size={11} /> Stop
              </button>
            ) : (
              !isLast &&
              t.sessionId && (
                <button className="btn ghost xs" onClick={forkHere} title="Start a new branch from this point">
                  <Icon name="branch" size={12} /> Branch<span className="hide-sm">{' here'}</span>
                </button>
              )
            )}
            <button className="btn ghost xs" onClick={openDetails}>
              Details
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BranchChips({ kids, activeId, onPick }: { kids: TurnNode[]; activeId?: string; onPick: (t: TurnNode) => void }) {
  return (
    <div className="branch-chips">
      {kids.map((k) => (
        <button key={k.id} className={`branch-chip ${k.id === activeId ? 'on' : ''}`} style={{ ['--branch' as any]: branchColor(k.branchId) }} onClick={() => onPick(k)}>
          <span className="branch-swatch" />
          <span className="ellipsis">{k.prompt}</span>
        </button>
      ))}
    </div>
  );
}

export function ThreadList({ board, onPick, onImport }: { board: Board; onPick: (id: string) => void; onImport?: () => void }) {
  const { nodes } = useStore();
  useTick();
  const tips = leaves(nodes, board.id);
  const total = turnsOf(nodes, board.id).length;
  if (!total)
    return (
      <div className="chat-empty">
        <div className="hero-mark">
          <Icon name="branch" size={26} />
        </div>
        <h2>Start a thread</h2>
        <p>Describe a task below. Every reply becomes a step you can come back to and branch from, so trying another approach never loses the first one.</p>
        {onImport && (
          <button className="btn import-cta" onClick={onImport}>
            <Icon name="download" size={14} /> Bring in Claude Code sessions
          </button>
        )}
      </div>
    );
  return (
    <div className="thread-list">
      <div className="list-head">
        <div className="list-title">Branches · {tips.length}</div>
        {onImport && (
          <button className="link-btn" onClick={onImport}>
            Bring in Claude Code sessions
          </button>
        )}
      </div>
      {tips.map((t) => {
        const depth = pathTo(nodes, t.id).length;
        return (
          <button key={t.id} className="thread-row" style={{ ['--branch' as any]: branchColor(t.branchId) }} onClick={() => onPick(t.id)}>
            <span className="branch-swatch tall" />
            <span className="thread-main">
              <span className="thread-prompt">{pathTo(nodes, t.id)[0]?.title ?? t.prompt}</span>
              <span className="thread-sub ellipsis">{isLive(t) ? currentActivity(t) : lastText(t) || STATUS_LABEL[t.status]}</span>
            </span>
            <span className="thread-side">
              <span className="thread-status">
                <StatusDot status={t.status} />
                {t.status === 'waiting' ? 'Needs you' : timeAgo(t.finishedAt ?? t.createdAt)}
              </span>
              <span className="faint">
                {depth} step{depth === 1 ? '' : 's'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Chat({
  board,
  targetId,
  setTargetId,
  openDetails,
  onImport,
}: {
  board: Board;
  targetId: string | null;
  setTargetId: (id: string | null) => void;
  openDetails: (id: string) => void;
  onImport?: () => void;
}) {
  const { nodes } = useStore();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const path = useMemo(() => (targetId ? pathTo(nodes, targetId) : []), [nodes, targetId]);
  const last = path[path.length - 1];
  const lastKids = last ? childrenOf(nodes, last.id) : [];

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  useLayoutEffect(() => {
    stick.current = true;
  }, [targetId]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [path, last?.events]);

  if (!targetId || !last) {
    return (
      <div className="chat" ref={scroller}>
        <div className="chat-inner">
          <ThreadList board={board} onPick={setTargetId} onImport={onImport} />
        </div>
      </div>
    );
  }

  const pickKid = (k: TurnNode) => setTargetId(latestLeaf(nodes, k.id).id);

  return (
    <div className="chat" ref={scroller} onScroll={onScroll}>
      <div className="chat-inner">
        <button className="back-link" onClick={() => setTargetId(null)}>
          <Icon name="chevronLeft" size={14} /> All branches
        </button>
        {path.map((t, i) => {
          const kids = childrenOf(nodes, t.id);
          const next = path[i + 1];
          return (
            <Fragment key={t.id}>
              {(i === 0 || path[i - 1].branchId !== t.branchId) && (
                <div className="chat-note">
                  <NoteBar branchId={t.branchId} />
                </div>
              )}
              <Turn
                t={t}
                isLast={i === path.length - 1}
                forkHere={() => {
                  setTargetId(t.id);
                  setTimeout(() => composerFocus.current?.focus(), 0);
                }}
                openDetails={() => openDetails(t.id)}
              />
              {next && kids.length > 1 && (
                <div className="fork-point">
                  <div className="fork-label">
                    <Icon name="branch" size={13} /> {kids.length} branches from here
                  </div>
                  <BranchChips kids={kids} activeId={next.id} onPick={pickKid} />
                </div>
              )}
            </Fragment>
          );
        })}
        {lastKids.length > 0 && (
          <div className="fork-point new">
            <div className="fork-label">
              <Icon name="branch" size={13} /> Sending now starts a new branch. Existing ones:
            </div>
            <BranchChips kids={lastKids} onPick={pickKid} />
          </div>
        )}
      </div>
    </div>
  );
}
