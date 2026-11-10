import { useEffect, useRef, useState } from 'react';
import { MicButton } from './Mic.tsx';
import type { Board, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { branchColor } from './nodes.tsx';
import { useStore } from './store.ts';
import { isLive } from './tree.ts';
import { useIsMobile } from './ui.tsx';

const draftKey = (boardId: string) => `forkspace:draft:${boardId}`;
const readDraft = (k: string) => {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
};
const writeDraft = (k: string, v: string) => {
  try {
    v ? localStorage.setItem(k, v) : localStorage.removeItem(k);
  } catch {}
};

export const composerFocus = { current: null as HTMLTextAreaElement | null };

export function Composer({ target, board, onSubmit, onClear }: { target?: TurnNode; board: Board; onSubmit: (p: string) => Promise<boolean>; onClear: () => void }) {
  const { branches } = useStore();
  const mobile = useIsMobile();
  const [text, setText] = useState(() => readDraft(draftKey(board.id)));
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const isFork = !!target && branches[target.branchId]?.headNodeId !== target.id;
  const targetBusy = !!target && isLive(target);

  useEffect(() => {
    composerFocus.current = ref.current;
  });
  // Views pad themselves by this much so nothing hides under the floating composer.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--composer-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => writeDraft(draftKey(board.id), text), [text, board.id]);

  // Auto-grow.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, mobile ? 160 : 240) + 'px';
  }, [text, mobile]);

  const go = async () => {
    if (!text.trim() || busy || targetBusy) return;
    setBusy(true);
    if (await onSubmit(text.trim())) {
      setText('');
      // Phones: drop the keyboard so you can watch the agent work.
      if (mobile) ref.current?.blur();
    }
    setBusy(false);
  };

  const color = target ? branchColor(target.branchId) : undefined;

  return (
    <div className="composer" ref={box}>
      <div className="composer-box" style={color ? { ['--branch' as any]: color } : undefined}>
        <div className="composer-target">
          {target ? (
            <>
              <span className={`target-chip ${isFork ? 'fork' : ''}`}>
                <Icon name={isFork ? 'branch' : 'chat'} size={12} />
                {isFork ? 'New branch from' : 'Continue'}
              </span>
              <span className="target-text">{target.prompt}</span>
              <button className="link-btn" onClick={onClear}>
                New thread
              </button>
            </>
          ) : (
            <>
              <span className="target-chip new">
                <Icon name="plus" size={12} /> New thread
              </span>
              <span className="target-text faint">{board.name}</span>
            </>
          )}
        </div>
        <div className="composer-row">
          <textarea
            ref={ref}
            value={text}
            rows={1}
            enterKeyHint={mobile ? 'enter' : 'send'}
            placeholder={targetBusy ? 'Agent is working. Type your next step…' : target ? 'What next?' : 'Describe a task for a new agent…'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !mobile && !e.nativeEvent.isComposing) {
                e.preventDefault();
                go();
              }
              if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
            }}
          />
          <MicButton text={text} setText={(v) => setText(v)} onStop={() => ref.current?.focus()} />
          <button
            className="send-btn"
            // Keep focus in the textarea: on phones a blur here hides the keyboard and shifts the layout mid-tap.
            onPointerDown={(e) => e.preventDefault()}
            onMouseDown={(e) => e.preventDefault()}
            disabled={!text.trim() || busy || targetBusy} onClick={go} aria-label="Send" title={targetBusy ? 'Wait for the agent to finish' : 'Send (Enter)'}>
            {busy ? <span className="spinner light" /> : <Icon name="send" size={18} strokeWidth={2.25} />}
          </button>
        </div>
      </div>
    </div>
  );
}
