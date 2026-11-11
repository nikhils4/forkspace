import { useEffect, useRef, useState, type RefObject } from 'react';
import type { TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';

// Keep scrolling past the top of the details panel and it moves to the step above in the thread
// (past the bottom: the step after). A pill fills up as you push, so it never happens by accident:
// let go early and nothing changes. Coasting into the edge doesn't count. You have to rest there
// a moment first, then push on purpose.

const NEED = 340; // how far to push (in scroll pixels) once you're at the edge
const DWELL = 350; // ms resting at the edge before pushing counts
const IDLE = 450; // ms without pushing and the pill lets go

type Dir = 'up' | 'down';

export function useStepPull(scroller: RefObject<HTMLElement | null>, prev: TurnNode | undefined, next: TurnNode | undefined, go: (n: TurnNode, dir: Dir) => void) {
  const [pull, setPull] = useState<{ dir: Dir; amt: number } | null>(null);
  const s = useRef({ dir: null as Dir | null, amt: 0, at: 0, edgeSince: { up: 0, down: 0 }, idle: 0 as any, touchY: 0 });
  const live = useRef({ prev, next, go });
  live.current = { prev, next, go };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const edges = () => ({ up: el.scrollTop <= 0, down: el.scrollTop + el.clientHeight >= el.scrollHeight - 1 });
    // Remember when the panel came to rest at each edge.
    const markEdges = () => {
      const e = edges();
      const now = performance.now();
      s.current.edgeSince.up = e.up ? s.current.edgeSince.up || now : 0;
      s.current.edgeSince.down = e.down ? s.current.edgeSince.down || now : 0;
    };
    const reset = () => {
      s.current.dir = null;
      s.current.amt = 0;
      setPull(null);
    };
    const push = (dir: Dir, by: number) => {
      const st = s.current;
      const target = dir === 'up' ? live.current.prev : live.current.next;
      const now = performance.now();
      if (!target || !st.edgeSince[dir] || now - st.edgeSince[dir] < DWELL) return false;
      if (st.dir !== dir) (st.dir = dir), (st.amt = 0);
      st.amt += by;
      clearTimeout(st.idle);
      st.idle = setTimeout(reset, IDLE);
      if (st.amt >= NEED) {
        reset();
        st.edgeSince = { up: 0, down: 0 };
        live.current.go(target, dir);
      } else setPull({ dir, amt: st.amt / NEED });
      return true;
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // pinch zoom
      markEdges();
      const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1);
      const e2 = edges();
      if (px < 0 && e2.up) push('up', -px);
      else if (px > 0 && e2.down) push('down', px);
      else if (s.current.dir) reset();
    };
    // Phones: pull down at the top (or up at the bottom) with a finger.
    // A touch has no coasting: being at the edge when the finger lands counts as resting there.
    const onTouchStart = (e: TouchEvent) => {
      s.current.touchY = e.touches[0].clientY;
      const e2 = edges();
      const rested = performance.now() - DWELL;
      s.current.edgeSince.up = e2.up ? rested : 0;
      s.current.edgeSince.down = e2.down ? rested : 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0].clientY;
      const dy = y - s.current.touchY;
      s.current.touchY = y;
      const e2 = edges();
      if (dy > 0 && e2.up) push('up', dy * 1.6);
      else if (dy < 0 && e2.down) push('down', -dy * 1.6);
    };
    const onTouchEnd = () => s.current.amt < NEED && reset();
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('scroll', markEdges, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd);
    markEdges();
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', markEdges);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      clearTimeout(s.current.idle);
    };
  }, [scroller]);

  return pull;
}

/** The pill that fills as you push: says where you'll land. */
export function StepPullHint({ pull, dir, target, step }: { pull: { dir: Dir; amt: number } | null; dir: Dir; target?: TurnNode; step: number }) {
  if (!target) return null;
  const on = pull?.dir === dir;
  const text = (target.title || target.prompt).replace(/\s+/g, ' ').trim();
  return (
    <div className={`step-pull ${dir} ${on ? 'on' : ''} ${on && pull!.amt > 0.98 ? 'full' : ''}`} aria-hidden={!on}>
      <div className="step-pull-pill" style={{ ['--amt' as any]: on ? pull!.amt : 0 }}>
        <Icon name={dir === 'up' ? 'chevronUp' : 'chevronDown'} size={13} />
        <b>Step {step}</b>
        <span>{text.length > 48 ? `${text.slice(0, 47)}…` : text}</span>
      </div>
    </div>
  );
}
