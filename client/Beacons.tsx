import { useReactFlow, useStore as useRFStore } from '@xyflow/react';
import type { TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { LiveLine, branchColor, liveActivity } from './nodes.tsx';

const liveText = (n: TurnNode) => {
  const a = liveActivity(n);
  return a ? `${a.verb} ${a.what ?? ''}` : '';
};

// Where the agents are working, wherever you are on the canvas.
// Zoomed out, a working card wears a readable tag (same size on screen at any zoom).
// Off screen, the tag waits at the edge of the view, pointing the way. Click it to fly there.

const PAD = 14;

export function Beacons({ live, onGo }: { live: TurnNode[]; onGo: (id: string) => void }) {
  const rf = useReactFlow();
  const [tx, ty, zoom] = useRFStore((s) => s.transform);
  const W = useRFStore((s) => s.width);
  const H = useRFStore((s) => s.height);
  if (!live.length || !W) return null;

  // What you can actually see: above the message box, left of the details panel.
  const composer = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--composer-h')) || 120;
  const host = document.querySelector('.pane.on .react-flow')?.getBoundingClientRect();
  const drawer = (document.querySelector('.drawer') as HTMLElement | null)?.getBoundingClientRect();
  const right = host && drawer && drawer.left > host.left + 200 && drawer.left < host.right ? drawer.left - host.left - 8 : W;
  const bottom = H - composer - 8;

  const out = live.flatMap((n) => {
    const internal = rf.getInternalNode(n.id);
    if (!internal) return [];
    const p = internal.internals.positionAbsolute;
    const w = (internal.measured?.width ?? 380) * zoom;
    const h = (internal.measured?.height ?? 200) * zoom;
    const x = p.x * zoom + tx;
    const y = p.y * zoom + ty;
    const cx = x + w / 2;
    const visible = x + w > 0 && x < right && y + h > 0 && y < bottom;
    if (visible) {
      // Close enough to read the card's own live line: no tag needed.
      if (zoom >= 0.32) return [];
      return [{ n, left: cx, top: Math.max(PAD + 4, y - 12), angle: null as number | null }];
    }
    // Off screen: pin to the nearest edge, with an arrow toward the card.
    const cy = y + h / 2;
    const left = Math.min(Math.max(cx, PAD + 90), right - PAD - 90);
    const top = Math.min(Math.max(cy, PAD + 16), bottom - PAD - 16);
    const angle = (Math.atan2(cy - top, cx - left) * 180) / Math.PI;
    return [{ n, left, top, angle }];
  });

  // Tags close together stack upward instead of covering each other.
  const placed: { l: number; r: number; t: number }[] = [];
  for (const b of out.sort((a, c) => a.top - c.top || a.left - c.left)) {
    const text = liveText(b.n);
    const half = Math.min(260, 46 + text.length * 7) / 2;
    let t = b.top;
    for (let tries = 0; tries < 8; tries++) {
      const hit = placed.find((p) => b.left - half < p.r && b.left + half > p.l && Math.abs(t - p.t) < 34);
      if (!hit) break;
      t = b.angle === null ? hit.t - 36 : hit.t + 36;
    }
    b.top = t;
    placed.push({ l: b.left - half, r: b.left + half, t });
  }

  return (
    <div className="beacons">
      {out.map(({ n, left, top, angle }) => (
        <button
          key={n.id}
          className={`beacon ${angle === null ? 'tag' : 'edge'} ${n.status === 'waiting' ? 'waiting' : ''}`}
          style={{ left, top, ['--branch' as any]: branchColor(n.branchId) }}
          onClick={() => onGo(n.id)}
          // Scrolling or pinching over a tag still moves the canvas.
          onWheel={(e) => {
            const pane = document.querySelector('.pane.on .react-flow__renderer');
            pane?.dispatchEvent(new WheelEvent('wheel', { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, bubbles: true, cancelable: true }));
          }}
          title={n.prompt}
        >
          <span className="beacon-dot" />
          <LiveLine node={n} />
          {angle !== null && (
            <span className="beacon-arrow" style={{ transform: `rotate(${angle}deg)` }}>
              <Icon name="chevronRight" size={13} />
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
