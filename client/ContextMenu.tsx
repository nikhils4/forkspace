import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons.tsx';

export type MenuItem =
  | 'sep'
  | {
      label: string;
      icon?: IconName;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      /** Ask for a second click with this label before running (for destructive actions). */
      confirm?: string;
      onClick: () => void;
    }
  | { swatches: string[]; current?: string; onPick: (c: string) => void };

/** A small floating menu at the pointer. Stays on screen, closes on outside click, Esc or scroll. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [arming, setArming] = useState<number | null>(null);
  const [sel, setSel] = useState(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // offsetWidth/Height ignore the opening scale animation.
    setPos({ x: Math.max(8, Math.min(x, innerWidth - el.offsetWidth - 8)), y: Math.max(8, Math.min(y, innerHeight - el.offsetHeight - 8)) });
  }, [x, y]);

  const actionable = items.map((it, i) => (it !== 'sep' && 'onClick' in it && !it.disabled ? i : -1)).filter((i) => i >= 0);

  const run = (i: number) => {
    const it = items[i];
    if (it === 'sep' || !('onClick' in it) || it.disabled) return;
    if (it.confirm && arming !== i) return setArming(i);
    onClose();
    it.onClick();
  };

  useEffect(() => {
    const down = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc closes just this menu, not whatever is behind it.
        e.stopImmediatePropagation();
        onClose();
      }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const at = actionable.indexOf(sel);
        const next = e.key === 'ArrowDown' ? actionable[(at + 1) % actionable.length] : actionable[(at - 1 + actionable.length) % actionable.length];
        setSel(next ?? -1);
      } else if (e.key === 'Enter' && sel >= 0) {
        e.preventDefault();
        run(sel);
      }
    };
    const wheel = () => onClose();
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key, true);
    addEventListener('wheel', wheel, { passive: true });
    addEventListener('resize', onClose);
    return () => {
      removeEventListener('pointerdown', down, true);
      removeEventListener('keydown', key, true);
      removeEventListener('wheel', wheel);
      removeEventListener('resize', onClose);
    };
  });

  // Portal to <body>: view panes are transformed, which would shift a fixed menu away from the pointer.
  return createPortal(
    <div className="ctx" ref={ref} style={{ left: pos.x, top: pos.y }} role="menu" onContextMenu={(e) => (e.preventDefault(), e.stopPropagation())}>
      {items.map((it, i) => {
        if (it === 'sep') return <div key={i} className="ctx-sep" />;
        if ('swatches' in it)
          return (
            <div key={i} className="ctx-swatches">
              {it.swatches.map((c) => (
                <button
                  key={c}
                  className={`ctx-swatch ${c === it.current ? 'on' : ''}`}
                  style={{ background: c }}
                  aria-label="Note colour"
                  onClick={() => {
                    it.onPick(c);
                    onClose();
                  }}
                />
              ))}
            </div>
          );
        const armed = arming === i;
        return (
          <button
            key={i}
            role="menuitem"
            className={`ctx-item ${it.danger ? 'danger' : ''} ${armed ? 'armed' : ''} ${sel === i ? 'sel' : ''}`}
            disabled={it.disabled}
            onPointerEnter={() => setSel(i)}
            onClick={() => run(i)}
          >
            {it.icon ? <Icon name={it.icon} size={14} /> : <span className="ctx-noicon" />}
            <span className="ctx-label">{armed ? it.confirm : it.label}</span>
            {it.hint && !armed && <kbd>{it.hint}</kbd>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
