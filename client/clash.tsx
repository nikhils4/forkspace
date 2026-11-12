import type { Branch, CanvasNode, Overlap } from '../shared/types.ts';
import { composerInsert } from './Composer.tsx';
import { Icon } from './icons.tsx';
import { branchColor } from './nodes.tsx';
import { goToStep, useStore } from './store.ts';
import { pathTo } from './tree.ts';

/** A thread's name: its title, or the first thing you asked it. */
export function threadName(nodes: Record<string, CanvasNode>, branch: Branch | undefined) {
  const head = branch?.headNodeId;
  if (!head) return 'another thread';
  const root = pathTo(nodes, head)[0];
  const t = (root?.title || root?.prompt || 'another thread').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

export const overlapText = (o: Overlap) => (o.count === 1 ? o.files[0].split('/').pop()! : `${o.count} files`);

/** Details panel: which other threads change the same files, and what to do about it. */
export function OverlapSection({ branchId }: { branchId: string }) {
  const { branches, nodes } = useStore();
  const list = branches[branchId]?.overlaps ?? [];
  if (!list.length) return null;
  return (
    <section className="ds overlap-ds">
      <div className="ds-label">
        <Icon name="alert" size={12} /> Overlaps with other agents
      </div>
      {list.map((o) => {
        const other = branches[o.branchId];
        const name = threadName(nodes, other);
        const head = other?.headNodeId;
        const files = o.files.join(', ') + (o.count > o.files.length ? ` and ${o.count - o.files.length} more` : '');
        return (
          <div key={o.branchId} className="overlap-card" style={{ ['--other' as any]: branchColor(o.branchId) }}>
            <div className="overlap-who">
              <span className="overlap-dot" />
              <b className="ellipsis" title={name}>
                {name}
              </b>
            </div>
            <div className="overlap-why">
              {o.kind === 'folder'
                ? 'Both agents are editing these files in the same folder right now. One can overwrite the other.'
                : 'Both threads changed these files in their own copies. Merging the second one will need care.'}
            </div>
            <div className="overlap-files">
              {o.files.map((f) => (
                <code key={f} title={f}>
                  {f.split('/').pop()}
                </code>
              ))}
              {o.count > o.files.length && <span className="faint">+{o.count - o.files.length} more</span>}
            </div>
            <div className="overlap-actions">
              {head && (
                <button className="btn ghost xs" onClick={() => goToStep(head)}>
                  Go there
                </button>
              )}
              <button
                className="btn ghost xs"
                title="Puts a note for this agent in the message box, for you to edit and send"
                onClick={() =>
                  composerInsert(
                    `Heads up: another agent (“${name}”) is also changing ${files}. Stay out of those files if you can; if you can't, keep your changes there small and tell me exactly what you changed, so merging is easy.`,
                  )
                }
              >
                Tell this agent
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
