import { useReactFlow, useStore as useRFStore } from '@xyflow/react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { NoteNode, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { LiveLine, branchColor, liveActivity } from './nodes.tsx';
import { isLive } from './tree.ts';

// A finished card you haven't looked at yet.
const readyLabel = (n: TurnNode) => (n.status === 'error' ? 'Failed, take a look' : 'Ready for review');
const liveText = (n: TurnNode) => {
  if (!isLive(n)) return readyLabel(n);
  const a = liveActivity(n);
  return a ? `${a.verb} ${a.what ?? ''}` : '';
};
// A note's pointer shows the start of its first line.
const noteText = (n: NoteNode) => {
  const line = n.text.split('\n').find((l) => l.trim())?.replace(/^[#>*\-\s[\]x]+/i, '').trim() || 'Note';
  return line.length > 22 ? `${line.slice(0, 21)}…` : line;
};

// Where the agents are working, wherever you are on the canvas.
// Zoomed out, a working card wears a readable tag (same size on screen at any zoom).
// Off screen, the tag waits at the edge of the view, pointing the way. Click it to fly there.
// Finished cards you haven't looked at yet get a quieter "Ready for review" tag the same way.
// Notes off screen get faint little pointers too, so they're one click away without shouting.

const PAD = 14;
const MAX_NOTES = 6;

type Item = { kind: 'turn'; n: TurnNode } | { kind: 'note'; n: NoteNode };
type Placed = Item & { left: number; top: number; angle: number | null; half: number };

export function Beacons({ live, ready, notes, onGo }: { live: TurnNode[]; ready: TurnNode[]; notes: NoteNode[]; onGo: (id: string) => void }) {
  const rf = useReactFlow();
  const [tx, ty, zoom] = useRFStore((s) => s.transform);
  const W = useRFStore((s) => s.width);
  const H = useRFStore((s) => s.height);
  // Real on-screen widths, so a long tag is kept fully inside the view (not cut off at the edge).
  const widths = useRef(new Map<string, number>());
  const box = useRef<HTMLDivElement>(null);
  const [, remeasured] = useState(0);
  useLayoutEffect(() => {
    let changed = false;
    box.current?.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => {
      const id = el.dataset.id!;
      const w = el.offsetWidth;
      if (Math.abs((widths.current.get(id) ?? 0) - w) > 2) {
        widths.current.set(id, w);
        changed = true;
      }
    });
    if (changed) remeasured((x) => x + 1);
  });

  if ((!live.length && !ready.length && !notes.length) || !W) return null;

  // What you can actually see: above the message box, left of the details panel.
  const composer = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--composer-h')) || 120;
  const host = document.querySelector('.pane.on .react-flow')?.getBoundingClientRect();
  const drawer = (document.querySelector('.drawer') as HTMLElement | null)?.getBoundingClientRect();
  const right = host && drawer && drawer.left > host.left + 200 && drawer.left < host.right ? drawer.left - host.left - 8 : W;
  const bottom = H - composer - 8;

  const halfOf = (it: Item) => {
    const known = widths.current.get(it.n.id);
    if (known) return known / 2;
    return it.kind === 'note' ? (44 + noteText(it.n).length * 6.5) / 2 : Math.min(260, 70 + liveText(it.n).length * 7) / 2;
  };
  // Keep the whole tag inside the view, however wide it is.
  const clampX = (cx: number, half: number) => Math.min(Math.max(cx, PAD + half), Math.max(PAD + half, right - PAD - half));

  const place = (it: Item): Placed[] => {
    const internal = rf.getInternalNode(it.n.id);
    if (!internal) return [];
    const p = internal.internals.positionAbsolute;
    const w = (internal.measured?.width ?? 380) * zoom;
    const h = (internal.measured?.height ?? 200) * zoom;
    const x = p.x * zoom + tx;
    const y = p.y * zoom + ty;
    const cx = x + w / 2;
    const half = halfOf(it);
    const visible = x + w > 0 && x < right && y + h > 0 && y < bottom;
    if (visible) {
      // Notes on screen speak for themselves; cards close enough to read need no tag either.
      if (it.kind === 'note' || zoom >= 0.32) return [];
      return [{ ...it, left: clampX(cx, half), top: Math.max(PAD + 34, y - 12), angle: null, half }];
    }
    // Off screen: pin to the nearest edge, with an arrow toward the card.
    const cy = y + h / 2;
    const left = clampX(cx, half);
    const top = Math.min(Math.max(cy, PAD + 16), bottom - PAD - 16);
    const angle = (Math.atan2(cy - top, cx - left) * 180) / Math.PI;
    return [{ ...it, left, top, angle, half }];
  };

  const cards = [...live, ...ready].flatMap((n) => place({ kind: 'turn', n }));
  // Only the few nearest notes, so a busy board doesn't ring the view with pointers.
  const mid = { x: right / 2, y: bottom / 2 };
  const dist = (b: Placed) => {
    const p = rf.getInternalNode(b.n.id)!.internals.positionAbsolute;
    return Math.hypot(p.x * zoom + tx - mid.x, p.y * zoom + ty - mid.y);
  };
  const notePins = notes
    .flatMap((n) => place({ kind: 'note', n }))
    .sort((a, b) => dist(a) - dist(b))
    .slice(0, MAX_NOTES);

  // Tags close together stack instead of covering each other. Cards first, so they get the best spots.
  const placed: { l: number; r: number; t: number }[] = [];
  const stack = (list: Placed[]) => {
    for (const b of list.sort((a, c) => a.top - c.top || a.left - c.left)) {
      let t = b.top;
      for (let tries = 0; tries < 8; tries++) {
        const hit = placed.find((p) => b.left - b.half < p.r && b.left + b.half > p.l && Math.abs(t - p.t) < 34);
        if (!hit) break;
        t = b.angle === null ? hit.t - 36 : hit.t + 36;
      }
      // Stacking can push a pin past the bottom: keep it above the message box.
      b.top = b.angle === null ? t : Math.min(t, bottom - PAD - 16);
      placed.push({ l: b.left - b.half, r: b.left + b.half, t: b.top });
    }
  };
  stack(cards);
  stack(notePins);

  // Scrolling or pinching over a tag still moves the canvas.
  const passWheel = (e: React.WheelEvent) => {
    const pane = document.querySelector('.pane.on .react-flow__renderer');
    pane?.dispatchEvent(new WheelEvent('wheel', { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, bubbles: true, cancelable: true }));
  };
  const arrow = (angle: number | null, size = 13) =>
    angle !== null && (
      <span className="beacon-arrow" style={{ transform: `rotate(${angle}deg)` }}>
        <Icon name="chevronRight" size={size} />
      </span>
    );

  return (
    <div className="beacons" ref={box}>
      {notePins.map(({ n, left, top, angle }) => {
        const note = n as NoteNode;
        return (
          <button key={note.id} data-id={note.id} className="beacon edge note-pin" style={{ left, top, ['--note' as any]: note.color }} onClick={() => onGo(note.id)} onWheel={passWheel} title={`Go to note: ${note.text.slice(0, 120)}`}>
            <span className="note-pin-dot" />
            <span className="beacon-text">{noteText(note)}</span>
            {arrow(angle, 11)}
          </button>
        );
      })}
      {cards.map(({ n: node, left, top, angle }) => {
        const n = node as TurnNode;
        return (
          <button
            key={n.id}
            data-id={n.id}
            className={`beacon ${angle === null ? 'tag' : 'edge'} ${n.status === 'waiting' ? 'waiting' : ''} ${isLive(n) ? '' : `ready ${n.status}`}`}
            style={{ left, top, ['--branch' as any]: branchColor(n.branchId) }}
            onClick={() => onGo(n.id)}
            onWheel={passWheel}
            title={n.prompt}
          >
            {isLive(n) ? (
              <>
                <span className="beacon-dot" />
                <LiveLine node={n} />
              </>
            ) : (
              <>
                <span className="beacon-check">
                  <Icon name={n.status === 'error' ? 'x' : 'check'} size={11} strokeWidth={3} />
                </span>
                <span className="beacon-text">{readyLabel(n)}</span>
              </>
            )}
            {arrow(angle)}
          </button>
        );
      })}
    </div>
  );
}
