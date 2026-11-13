import { useState } from 'react';
import type { StepOption, TurnNode } from '../shared/types.ts';
import { composerInsert } from './Composer.tsx';
import { Icon } from './icons.tsx';
import { useStore } from './store.ts';
import { isTurn } from './tree.ts';

// The choices Claude offered at a step, kept beside its card: "these were the options here".
// Take one and it lands in the message box, aimed at this card (so it continues or branches from
// here), for you to send or edit. One you already took is ticked.

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Which options a later step (a child of this card) already went with. */
export function useTaken(node: TurnNode) {
  const { nodes } = useStore();
  const kids = Object.values(nodes).filter((n): n is TurnNode => isTurn(n) && n.parentId === node.id);
  return (o: StepOption) => {
    const p = norm(o.prompt).slice(0, 48);
    const l = norm(o.label);
    return kids.find((k) => {
      const kp = norm(k.prompt);
      return kp.includes(p) || (l.length > 6 && kp.includes(l));
    });
  };
}

/** Put an option into the message box, aimed at this card. */
export function pickOption(aimAt: () => void, o: StepOption) {
  aimAt();
  setTimeout(() => composerInsert(o.prompt), 0);
}

function List({ node, onPick, compact }: { node: TurnNode; onPick: (o: StepOption) => void; compact?: boolean }) {
  const taken = useTaken(node);
  return (
    <ol className={`opt-list ${compact ? 'compact' : ''}`}>
      {(node.options ?? []).map((o, i) => {
        const t = taken(o);
        return (
          <li key={i} className={`opt ${t ? 'taken' : ''}`}>
            <span className="opt-n">{t ? <Icon name="check" size={10} strokeWidth={3} /> : i + 1}</span>
            <span className="opt-text">
              <b>{o.label}</b>
              {o.detail && <span>{o.detail}</span>}
              {t && <em>Taken in the next step</em>}
            </span>
            <button className="opt-use" onClick={() => onPick(o)} title={`Put this in the message box:\n\n${o.prompt}`}>
              {t ? 'Again' : 'Use'}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Beside a card on the canvas: a small tab on its left edge ("3 options"); open, the list.
 * Starts open on the latest card of a branch while none has been taken yet.
 */
export function CardOptions({ node, isHead, onPick }: { node: TurnNode; isHead: boolean; onPick: (o: StepOption) => void }) {
  const taken = useTaken(node);
  const list = node.options ?? [];
  const anyTaken = list.some((o) => taken(o));
  const [open, setOpen] = useState<boolean | null>(null);
  if (!list.length) return null;
  const shown = open ?? (isHead && !anyTaken);
  return (
    <div className={`card-options nodrag nowheel ${shown ? 'open' : ''}`}>
      <button className="opt-tab" onClick={() => setOpen(!shown)} title={shown ? 'Hide the options' : 'The options Claude offered here'}>
        <Icon name="spark" size={12} />
        {list.length} option{list.length === 1 ? '' : 's'}
        {anyTaken && <Icon name="check" size={11} strokeWidth={3} />}
      </button>
      {shown && (
        <div className="opt-box">
          <div className="opt-head">Claude offered</div>
          <List node={node} onPick={onPick} compact />
        </div>
      )}
    </div>
  );
}

/** In the details panel and the chat: the options as a section. */
export function OptionsSection({ node, onPick }: { node: TurnNode; onPick: (o: StepOption) => void }) {
  if (!node.options?.length) return null;
  return (
    <div className="opt-section">
      <List node={node} onPick={onPick} />
    </div>
  );
}
