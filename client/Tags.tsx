import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TAG_COLORS, type Board, type TaskTag, type TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { send, useStore } from './store.ts';

// Quick tags: you make them per project (security, infra…) and put them on tasks. Each has a colour.

export const tagsOf = (board: Board | undefined, root: TurnNode): TaskTag[] => {
  const all = board?.tags ?? [];
  return (root.tags ?? []).map((id) => all.find((t) => t.id === id)).filter((t): t is TaskTag => !!t);
};

export const TAG_HEX: Record<string, string> = {
  red: '#e5484d',
  orange: '#f76b15',
  amber: '#e2a336',
  green: '#30a46c',
  teal: '#12a594',
  blue: '#0090ff',
  violet: '#8e4ec6',
  pink: '#d6409f',
  grey: '#8b8d98',
};
/** A tab's colour band: one even segment per tag (up to 3), drawn in the tab's own shape. */
export function TagBand({ tags }: { tags: TaskTag[] }) {
  if (!tags.length) return null;
  const cs = tags.slice(0, 3).map((t) => TAG_HEX[t.color] ?? TAG_HEX.grey);
  const band = cs.length === 1 ? cs[0] : `linear-gradient(to right, ${cs.map((c, i) => `${c} ${(i * 100) / cs.length}% ${((i + 1) * 100) / cs.length}%`).join(', ')})`;
  return <span className="tk-band" style={{ ['--band' as any]: band, ['--tg1' as any]: cs[0] }} aria-hidden />;
}

/** Named chips, for the task's header. Click to change. */
export function TagChips({ tags, onEdit }: { tags: TaskTag[]; onEdit: (e: React.MouseEvent) => void }) {
  return (
    <span className="tg-chips">
      {tags.map((t) => (
        <button key={t.id} className={`tg-chip tg-${t.color}`} onClick={onEdit} title="Change tags (T)">
          <span className="tg-dot" />
          {t.name}
        </button>
      ))}
      {!tags.length && (
        <button className="tg-add" onClick={onEdit} title="Tag this task (T)" aria-label="Tag this task">
          <Icon name="tag" size={13} />
        </button>
      )}
    </span>
  );
}

const newId = () => Math.random().toString(36).slice(2, 10);

/** Pick tags for a task, make new ones, recolour or remove them. */
export function TagPicker({ board: given, root: givenRoot, x, y, onClose }: { board: Board; root: TurnNode; x: number; y: number; onClose: () => void }) {
  // Always the latest: the props can be a snapshot from when the menu opened.
  const { nodes, boards } = useStore();
  const board = boards.find((b) => b.id === given.id) ?? given;
  const root = (nodes[givenRoot.id] as TurnNode | undefined) ?? givenRoot;
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const all = board.tags ?? [];
  const on = new Set(root.tags ?? []);
  const shown = all.filter((t) => t.name.toLowerCase().includes(q.trim().toLowerCase()));
  const exact = all.some((t) => t.name.toLowerCase() === q.trim().toLowerCase());
  const canMake = !!q.trim() && !exact;
  const rows = shown.length + (canMake ? 1 : 0);

  useLayoutEffect(() => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(x, innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, innerHeight - r.height - 8)),
    });
  }, [x, y]);
  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    addEventListener('pointerdown', down, true);
    return () => removeEventListener('pointerdown', down, true);
  }, []);
  useEffect(() => setHi(0), [q]);

  const setBoardTags = (tags: TaskTag[]) => send({ type: 'updateBoard', id: board.id, patch: { tags } });
  const toggle = (t: TaskTag) => {
    const ids = on.has(t.id) ? [...on].filter((i) => i !== t.id) : [...on, t.id];
    send({ type: 'setTaskTags', nodeId: root.id, tags: ids });
  };
  const make = () => {
    const name = q.trim().slice(0, 32);
    if (!name) return;
    // The next colour nobody uses yet, so tags tell apart at a glance.
    const used = new Set(all.map((t) => t.color));
    const color = TAG_COLORS.find((c) => c !== 'grey' && !used.has(c)) ?? TAG_COLORS[all.length % TAG_COLORS.length];
    const t = { id: newId(), name, color };
    setBoardTags([...all, t]);
    send({ type: 'setTaskTags', nodeId: root.id, tags: [...on, t.id] });
    setQ('');
  };
  const recolor = (t: TaskTag) => {
    const next = TAG_COLORS[(TAG_COLORS.indexOf(t.color as any) + 1) % TAG_COLORS.length];
    setBoardTags(all.map((x) => (x.id === t.id ? { ...x, color: next } : x)));
  };
  const remove = (t: TaskTag) => {
    setBoardTags(all.filter((x) => x.id !== t.id));
    if (on.has(t.id))
      send({
        type: 'setTaskTags',
        nodeId: root.id,
        tags: [...on].filter((i) => i !== t.id),
      });
  };

  return (
    <div className="tg-pick" ref={box} style={pos} role="dialog" aria-label="Tags">
      <input
        className="tg-q"
        autoFocus
        value={q}
        placeholder={all.length ? 'Find or make a tag' : 'Make a tag, like security'}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
          if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(rows - 1, h + 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
          if (e.key === 'Enter') {
            e.preventDefault();
            if (hi < shown.length) toggle(shown[hi]);
            else if (canMake) make();
          }
        }}
      />
      <div className="tg-list">
        {shown.map((t, i) => (
          <div key={t.id} className={`tg-row ${i === hi ? 'hi' : ''}`} onMouseEnter={() => setHi(i)}>
            <button className="tg-row-main" onClick={() => toggle(t)}>
              <span className={`tg-check ${on.has(t.id) ? 'on' : ''}`}>{on.has(t.id) && <Icon name="check" size={10} />}</span>
              <span className={`tg-dot tg-${t.color}`} />
              <span className="ellipsis">{t.name}</span>
            </button>
            <button className={`tg-swatch tg-${t.color}`} onClick={() => recolor(t)} title="Change colour" aria-label={`Change ${t.name}'s colour`}>
              <span className="tg-dot" />
            </button>
            <button className="tg-del" onClick={() => remove(t)} title="Remove this tag from the project" aria-label={`Remove ${t.name}`}>
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        {canMake && (
          <button className={`tg-row tg-make ${hi === shown.length ? 'hi' : ''}`} onMouseEnter={() => setHi(shown.length)} onClick={make}>
            <Icon name="plus" size={12} /> Make “{q.trim()}”
          </button>
        )}
        {!rows && <div className="tg-empty">Type a name and press Enter.</div>}
      </div>
    </div>
  );
}
