import type { TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { Permission, STATUS_LABEL, StatusDot, branchColor } from './nodes.tsx';
import { send, useStore } from './store.ts';
import { currentActivity, isLive, lastText } from './tree.ts';
import { timeAgo, useTick } from './ui.tsx';

export function useAgents() {
  const { nodes } = useStore();
  const turns = Object.values(nodes).filter((n): n is TurnNode => n.kind === 'turn');
  const waiting = turns.filter((t) => t.status === 'waiting').sort((a, b) => a.createdAt - b.createdAt);
  const running = turns.filter((t) => t.status === 'running').sort((a, b) => b.createdAt - a.createdAt);
  const dayAgo = Date.now() - 86400000;
  const recent = turns
    .filter((t) => !isLive(t) && (t.finishedAt ?? t.createdAt) > dayAgo)
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
    .slice(0, 12);
  return { waiting, running, recent };
}

function AgentItem({ t, onOpen, compact }: { t: TurnNode; onOpen: (t: TurnNode) => void; compact?: boolean }) {
  const { boards } = useStore();
  const board = boards.find((b) => b.id === t.boardId);
  const live = isLive(t);
  return (
    <div className={`agent-item status-${t.status} ${compact ? 'compact' : ''}`} style={{ ['--branch' as any]: branchColor(t.branchId) }}>
      <button className="agent-main" onClick={() => onOpen(t)}>
        <span className="agent-top">
          <StatusDot status={t.status} />
          <span className="agent-board">{board?.name}</span>
          <span className="faint">· {t.status === 'waiting' ? 'Needs you' : live ? STATUS_LABEL[t.status] : timeAgo(t.finishedAt)}</span>
          <Icon name="chevronRight" size={14} className="agent-chev" />
        </span>
        <span className="agent-prompt">{t.prompt}</span>
        {!compact && <span className="agent-activity ellipsis">{live ? currentActivity(t) : lastText(t) || t.error || ''}</span>}
      </button>
      {!compact && t.pending && <Permission node={t} p={t.pending} />}
      {!compact && t.status === 'running' && (
        <div className="agent-actions">
          <button className="btn danger-ghost xs" onClick={() => send({ type: 'stop', nodeId: t.id })}>
            <Icon name="stop" size={11} /> Stop
          </button>
        </div>
      )}
    </div>
  );
}

/** Full-page inbox (phone tab). */
export function Inbox({ onOpen }: { onOpen: (t: TurnNode) => void }) {
  useTick();
  const { waiting, running, recent } = useAgents();
  const none = !waiting.length && !running.length && !recent.length;
  return (
    <div className="page">
      <div className="page-inner">
        <h1 className="page-title">Agents</h1>
        {none && (
          <div className="empty-note">
            <Icon name="inbox" size={22} />
            <div>Nothing running. Agents that need you will show up here first.</div>
          </div>
        )}
        {waiting.length > 0 && (
          <section className="inbox-section">
            <div className="list-title warn">Needs you · {waiting.length}</div>
            {waiting.map((t) => (
              <AgentItem key={t.id} t={t} onOpen={onOpen} />
            ))}
          </section>
        )}
        {running.length > 0 && (
          <section className="inbox-section">
            <div className="list-title">Working · {running.length}</div>
            {running.map((t) => (
              <AgentItem key={t.id} t={t} onOpen={onOpen} />
            ))}
          </section>
        )}
        {recent.length > 0 && (
          <section className="inbox-section">
            <div className="list-title">Last 24 hours</div>
            {recent.map((t) => (
              <AgentItem key={t.id} t={t} onOpen={onOpen} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

/** Sidebar version (desktop). */
export function SidebarAgents({ onOpen }: { onOpen: (t: TurnNode) => void }) {
  useTick();
  const { waiting, running } = useAgents();
  if (!waiting.length && !running.length) return <div className="side-empty">No agents running</div>;
  return (
    <>
      {[...waiting, ...running].map((t) => (
        <AgentItem key={t.id} t={t} onOpen={onOpen} compact />
      ))}
    </>
  );
}
