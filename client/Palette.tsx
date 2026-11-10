import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './icons.tsx';

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: IconName;
  color?: string;
  keywords?: string;
  run: () => void;
}

function score(q: string, text: string) {
  if (!q) return 1;
  q = q.toLowerCase();
  text = text.toLowerCase();
  const i = text.indexOf(q);
  if (i >= 0) return 1000 - i - text.length / 50;
  let j = 0;
  for (const ch of text) if (ch === q[j]) j++;
  return j === q.length ? 100 - text.length / 20 : -1;
}

export function Palette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const scored = items
      .map((it) => ({ it, s: score(q.trim(), `${it.label} ${it.hint ?? ''} ${it.keywords ?? ''}`) }))
      .filter((x) => x.s >= 0);
    if (q.trim()) scored.sort((a, b) => b.s - a.s);
    // Without a query, keep groups in order and cap long ones (files).
    const out: PaletteItem[] = [];
    const per = new Map<string, number>();
    for (const { it } of scored) {
      const n = per.get(it.group) ?? 0;
      if (!q.trim() && n >= 6) continue;
      if (n >= 40) continue;
      per.set(it.group, n + 1);
      out.push(it);
    }
    return out;
  }, [items, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const run = (it?: PaletteItem) => {
    if (!it) return;
    onClose();
    it.run();
  };

  let lastGroup = '';
  return (
    <div className="sheet-bg palette-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="spark" size={16} />
          <input
            autoFocus
            value={q}
            placeholder="Search boards, branches, files and actions…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, shown.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(shown[sel]);
              } else if (e.key === 'Escape') onClose();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" ref={list}>
          {shown.length === 0 && <div className="faint pad">Nothing found</div>}
          {shown.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head && <div className="palette-group">{head}</div>}
                <button data-i={i} className={`palette-item ${i === sel ? 'on' : ''}`} onMouseMove={() => setSel(i)} onClick={() => run(it)}>
                  {it.color ? <span className="branch-swatch" style={{ ['--branch' as any]: it.color }} /> : <Icon name={it.icon ?? 'chevronRight'} size={15} />}
                  <span className="ellipsis">{it.label}</span>
                  {it.hint && <span className="palette-hint ellipsis">{it.hint}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
        </div>
      </div>
    </div>
  );
}
