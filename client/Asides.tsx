import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Aside, TurnNode } from '../shared/types.ts';
import { composerInsert, composerFocus } from './Composer.tsx';
import { Icon } from './icons.tsx';
import { Md } from './nodes.tsx';
import { request, send, toast } from './store.ts';

// Select any part of a card's details, ask "what is this?", read the answer right there, move on.
// Side questions never join the thread; one click turns one into a real branch.

const SUGGEST = ['What is this?', 'Explain simply', 'Why this way?', 'What does it mean for users?', 'How does it work?'];
const quoteOf = (q: string) =>
  q
    .trim()
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');

export const asidePrompt = (a: Pick<Aside, 'quote' | 'question'>) => `About this part of your answer:\n${quoteOf(a.quote)}\n\n${a.question}`;

interface Spot {
  quote: string;
  top: number;
  left: number;
}

/** The toolbar over a selection, the ask box, and the answer that streams in under it. */
export function SelectionAsk({ scroller, node, onBranch }: { scroller: RefObject<HTMLDivElement | null>; node: TurnNode; onBranch?: (prompt: string) => void }) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [asking, setAsking] = useState(false);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // A new card: start clean.
  useEffect(() => {
    setSpot(null);
    setAsking(false);
    setOpenId(null);
  }, [node.id]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => {
      const sel = window.getSelection();
      const text = sel?.toString() ?? '';
      if (!sel || sel.isCollapsed || text.trim().length < 2 || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const host = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
      if (!host || !el.contains(host) || host.closest('input, textarea, .aside-pop')) return;
      const r = range.getBoundingClientRect();
      const s = el.getBoundingClientRect();
      const left = Math.min(Math.max(8, r.left - s.left + r.width / 2), el.clientWidth - 8);
      setSpot({ quote: text.trim().slice(0, 4000), top: r.bottom - s.top + el.scrollTop + 6, left });
      setAsking(false);
      setOpenId(null);
    };
    const up = (e: Event) => {
      if ((e.target as HTMLElement).closest?.('.aside-pop')) return;
      setTimeout(read, 0);
    };
    // Clicking elsewhere in the panel (not on the toolbar) lets the toolbar go.
    const down = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.aside-pop')) return;
      setSpot((s) => (s && !asking ? null : s));
    };
    el.addEventListener('mouseup', up);
    el.addEventListener('keyup', up);
    el.addEventListener('mousedown', down);
    return () => {
      el.removeEventListener('mouseup', up);
      el.removeEventListener('keyup', up);
      el.removeEventListener('mousedown', down);
    };
  }, [scroller, asking]);

  // Esc closes the toolbar or the answer first, before it closes the panel.
  useEffect(() => {
    if (!spot) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        setSpot(null);
        setAsking(false);
        setOpenId(null);
      } else if (!asking && !openId && (e.key === '?' || e.key === 'a') && !(e.target as HTMLElement)?.closest?.('input, textarea')) {
        e.preventDefault();
        setAsking(true);
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [spot, asking, openId]);

  useEffect(() => {
    if (asking) setTimeout(() => input.current?.focus(), 0);
  }, [asking]);

  // Keep the box inside the panel horizontally.
  useLayoutEffect(() => {
    const b = box.current;
    const el = scroller.current;
    if (!b || !el || !spot) return;
    const w = b.offsetWidth;
    const x = Math.min(Math.max(12, spot.left - w / 2), el.clientWidth - w - 12);
    b.style.left = `${x}px`;
  });

  // Opening the ask box or an answer: bring it fully into view.
  const mode = openId ? 'answer' : asking ? 'ask' : spot ? 'bar' : '';
  useEffect(() => {
    if (mode === 'ask' || mode === 'answer') setTimeout(() => box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
  }, [mode]);

  if (!spot) return null;
  const aside = openId ? node.asides?.find((a) => a.id === openId) : undefined;

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text) return;
    setQ('');
    setAsking(false);
    try {
      const a = await request<Aside>({ type: 'askAside', nodeId: node.id, quote: spot.quote, question: text });
      setOpenId(a.id);
      window.getSelection()?.removeAllRanges();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div ref={box} className={`aside-pop ${aside || asking ? 'wide' : ''}`} style={{ top: spot.top }} onMouseDown={(e) => e.stopPropagation()}>
      {aside ? (
        <AsideCard node={node} a={aside} onBranch={onBranch} onClose={() => (setSpot(null), setOpenId(null))} live />
      ) : asking ? (
        <form
          className="aside-ask"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
        >
          <div className="aside-quote">{spot.quote}</div>
          <div className="aside-input">
            <Icon name="spark" size={14} />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about this…" />
            <button type="submit" className="icon-btn sm" disabled={!q.trim()} aria-label="Ask">
              <Icon name="send" size={14} />
            </button>
          </div>
          <div className="aside-chips">
            {SUGGEST.map((s) => (
              <button key={s} type="button" className="chip" onClick={() => void ask(s)}>
                {s}
              </button>
            ))}
          </div>
        </form>
      ) : (
        <div className="aside-bar" role="toolbar">
          <button onClick={() => setAsking(true)} title="Ask about this (A)">
            <Icon name="spark" size={14} /> Ask
          </button>
          <button
            onClick={() => {
              composerInsert(`${quoteOf(spot.quote)}\n\n`);
              setTimeout(() => composerFocus.current?.focus(), 0);
              setSpot(null);
            }}
            title="Quote it in your reply"
          >
            <Icon name="comment" size={14} /> Quote
          </button>
          <button
            onClick={() =>
              navigator.clipboard?.writeText(spot.quote).then(
                () => (toast('Copied'), setSpot(null)),
                () => toast('Could not copy', 'error'),
              )
            }
            title="Copy"
          >
            <Icon name="copy" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

/** One side question and its answer. */
export function AsideCard({ node, a, onBranch, onClose, live }: { node: TurnNode; a: Aside; onBranch?: (prompt: string) => void; onClose?: () => void; live?: boolean }) {
  const [open, setOpen] = useState(!!live);
  const [more, setMore] = useState('');
  const follow = async () => {
    const text = more.trim();
    if (!text) return;
    setMore('');
    try {
      await request<Aside>({ type: 'askAside', nodeId: node.id, quote: a.quote, question: text });
      setOpen(false);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className={`aside-card ${open ? 'open' : ''} ${a.busy ? 'busy' : ''}`}>
      <button className="aside-head" onClick={() => !live && setOpen(!open)}>
        <Icon name="spark" size={13} />
        <span className="aside-q">{a.question}</span>
        <span className="aside-on ellipsis">{a.quote}</span>
        {!live && <Icon name={open ? 'chevronUp' : 'chevronDown'} size={13} />}
      </button>
      {open && (
        <div className="aside-body">
          {a.answer ? <Md text={a.answer} partial={a.busy} /> : a.busy ? <div className="aside-doing"><span className="aside-spin" />{a.doing || 'Thinking'}…</div> : null}
          {a.busy && a.answer && a.doing && <div className="aside-doing"><span className="aside-spin" />{a.doing}…</div>}
          {a.error && <div className="error-box">{a.error}</div>}
          {!a.busy && (
            <div className="aside-actions">
              <form
                className="aside-more"
                onSubmit={(e) => {
                  e.preventDefault();
                  void follow();
                }}
              >
                <input value={more} onChange={(e) => setMore(e.target.value)} placeholder="Ask a follow-up…" />
              </form>
              {onBranch && (
                <button className="btn sm" onClick={() => (onBranch(asidePrompt(a)), onClose?.())} title="Send this as a real step, branching from this card">
                  <Icon name="branch" size={13} /> Branch
                </button>
              )}
              <button className="icon-btn sm" onClick={() => (send({ type: 'dropAside', nodeId: node.id, id: a.id }), onClose?.())} title="Remove" aria-label="Remove">
                <Icon name="trash" size={13} />
              </button>
              {live && (
                <button className="icon-btn sm" onClick={onClose} title="Close (Esc)" aria-label="Close">
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Every side question on a card, under its answer. */
export function AsideList({ node, onBranch }: { node: TurnNode; onBranch?: (prompt: string) => void }) {
  const list = node.asides ?? [];
  if (!list.length) return null;
  return (
    <section className="ds">
      <div className="ds-label">
        Side questions <span className="ds-meta">not part of the thread</span>
      </div>
      <div className="aside-list">
        {[...list].reverse().map((a) => (
          <AsideCard key={a.id} node={node} a={a} onBranch={onBranch} />
        ))}
      </div>
    </section>
  );
}
