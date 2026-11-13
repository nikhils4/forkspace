import type { StepOption, TurnNode } from '../shared/types.ts';
import { composerInsert } from './Composer.tsx';
import { Icon } from './icons.tsx';
import { useStore } from './store.ts';
import { isTurn } from './tree.ts';

// The work Claude listed at a step (tickets, issues, next steps, approaches), kept with the card.
// Each later step from that card is matched to the item it works on, so you can always tell which
// ticket a branch was for and which ones are still open. On the canvas it's one small chip in the
// card's footer; the list itself lives in the details panel and under the answer in the chat.

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** For each item: the later steps (children of this card) that went with it. */
export function useTaken(node: TurnNode) {
  const { nodes } = useStore();
  const kids = Object.values(nodes)
    .filter((n): n is TurnNode => isTurn(n) && n.parentId === node.id)
    .sort((a, b) => a.createdAt - b.createdAt);
  return (o: StepOption, i: number) =>
    kids.filter((k) => {
      if (k.picked) return k.picked.index === i;
      // Not matched yet: the prompt carries the item's own words.
      return !k.pickedChecked && norm(k.prompt).includes(norm(o.prompt).slice(0, 48));
    });
}

/** Put an item into the message box, aimed at this card. */
export function pickOption(aimAt: () => void, o: StepOption) {
  aimAt();
  setTimeout(() => composerInsert(o.prompt), 0);
}

const STATE: Record<string, string> = { running: 'In progress', waiting: 'Needs you', done: 'Done', error: 'Failed', stopped: 'Stopped' };

/** The list, with which items were taken and where. */
export function OptionsSection({ node, onPick, onGo }: { node: TurnNode; onPick: (o: StepOption) => void; onGo?: (id: string) => void }) {
  const taken = useTaken(node);
  const list = node.options ?? [];
  if (!list.length) return null;
  return (
    <ol className="opt-list">
      {list.map((o, i) => {
        const steps = taken(o, i);
        const last = steps[steps.length - 1];
        return (
          <li key={i} className={`opt ${steps.length ? 'taken' : ''}`}>
            <span className="opt-n">{steps.length ? <Icon name="check" size={10} strokeWidth={3} /> : i + 1}</span>
            <span className="opt-text">
              <b>{o.label}</b>
              {o.detail && <span>{o.detail}</span>}
              {last && (
                <button className="opt-where" onClick={() => onGo?.(last.id)} disabled={!onGo} title={onGo ? 'Show that step' : undefined}>
                  {STATE[last.status] ?? 'Started'}
                  {steps.length > 1 ? ` · ${steps.length} steps` : ''}
                  {onGo && <Icon name="chevronRight" size={11} />}
                </button>
              )}
            </span>
            <button className="opt-use" onClick={() => onPick(o)} title={`Put this in the message box:\n\n${o.prompt}`}>
              {steps.length ? 'Again' : 'Use'}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** In a card's footer: "4 listed · 1 picked". Opens the list in the details panel. */
export function OptionsChip({ node, onOpen }: { node: TurnNode; onOpen: () => void }) {
  const taken = useTaken(node);
  const list = node.options ?? [];
  if (!list.length) return null;
  const n = list.filter((o, i) => taken(o, i).length).length;
  return (
    <button
      className={`opt-chip ${n ? 'some' : ''}`}
      onClick={() => {
        onOpen();
        // The panel needs a moment to open; then bring the list into view.
        setTimeout(() => document.getElementById('ds-options')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 260);
      }}
      title={`Claude listed ${list.length} things to pick from here:\n${list.map((o, i) => `${taken(o, i).length ? '✓' : `${i + 1}.`} ${o.label}`).join('\n')}`}
    >
      <Icon name="grid" size={11} />
      {list.length} listed
      {n > 0 && <span className="opt-chip-n">{n} picked</span>}
    </button>
  );
}

/** On a step that went with an item from the list before it: which one. */
export function PickedLine({ node, onGo }: { node: TurnNode; onGo?: (id: string) => void }) {
  const { nodes } = useStore();
  if (!node.picked || !node.parentId) return null;
  const parent = nodes[node.parentId];
  const total = isTurn(parent) ? (parent.options?.length ?? 0) : 0;
  return (
    <button className="picked-line nodrag" onClick={(e) => (e.stopPropagation(), onGo?.(node.parentId!))} title="From the list Claude gave in the step before. Click to see that step.">
      <span className="picked-n">
        {node.picked.index + 1}
        {total ? <i>/{total}</i> : null}
      </span>
      <span className="ellipsis">{node.picked.label}</span>
    </button>
  );
}
