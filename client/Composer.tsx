import { useEffect, useRef, useState } from 'react';
import { MicButton, stopDictation } from './Mic.tsx';
import type { Attachment, Board, TurnNode } from '../shared/types.ts';
import { fileSize, uploadAttachment } from './Shots.tsx';
import { Icon } from './icons.tsx';
import { branchColor } from './nodes.tsx';
import { toast, useStore } from './store.ts';
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

type Pending = { key: string; name: string; size: number; preview?: string; att?: Attachment };

export const composerFocus = { current: null as HTMLTextAreaElement | null };

export function Composer({ target, board, onSubmit, onClear, drawerOpen }: { target?: TurnNode; board: Board; onSubmit: (p: string, attachments: Attachment[]) => Promise<boolean>; onClear: () => void; drawerOpen?: boolean }) {
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

  // The details panel floats over the right side: the box moves into the space left of it
  // (narrower, centred there) so the mic and send buttons never hide behind the panel.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (!drawerOpen) {
      el.style.removeProperty('--drawer-cover');
      return;
    }
    const measure = () => {
      const d = document.querySelector('.drawer') as HTMLElement | null;
      if (!d) return;
      const r = el.getBoundingClientRect();
      const dr = d.getBoundingClientRect();
      const cover = dr.left > r.left + 200 ? Math.max(0, r.right - dr.left + 14) : 0;
      el.style.setProperty('--drawer-cover', `${cover}px`);
    };
    const raf = requestAnimationFrame(measure);
    const d = document.querySelector('.drawer');
    const ro = new ResizeObserver(measure);
    if (d) ro.observe(d);
    addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener('resize', measure);
    };
  }, [drawerOpen]);

  // Auto-grow.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, mobile ? 160 : 240) + 'px';
  }, [text, mobile]);

  // Attachments: picked, pasted or dropped. Each uploads straight away; Send waits for them.
  const [atts, setAtts] = useState<Pending[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const uploading = atts.some((a) => !a.att);
  const ready = atts.flatMap((a) => (a.att ? [a.att] : []));
  const addFiles = (files: File[]) => {
    for (const f of files.slice(0, 20 - atts.length)) {
      const key = Math.random().toString(36).slice(2);
      const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
      const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined;
      setAtts((l) => [...l, { key, name, size: f.size, preview }]);
      uploadAttachment(f, name).then(
        (att) => setAtts((l) => l.map((a) => (a.key === key ? { ...a, att } : a))),
        (e: Error) => {
          toast(e.message, 'error');
          setAtts((l) => l.filter((a) => a.key !== key));
        },
      );
    }
  };
  const removeAtt = (key: string) =>
    setAtts((l) => {
      const a = l.find((x) => x.key === key);
      if (a?.preview) URL.revokeObjectURL(a.preview);
      return l.filter((x) => x.key !== key);
    });
  const pick = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => addFiles([...(input.files ?? [])]);
    input.click();
  };
  const canSend = (!!text.trim() || ready.length > 0) && !uploading && !busy && !targetBusy;

  const go = async () => {
    if (!canSend) return;
    // Still dictating? Stop the microphone; what it heard so far is already in the box.
    stopDictation();
    setBusy(true);
    if (await onSubmit(text.trim(), ready)) {
      setText('');
      atts.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      setAtts([]);
      // Phones: drop the keyboard so you can watch the agent work.
      if (mobile) ref.current?.blur();
    }
    setBusy(false);
  };

  const color = target ? branchColor(target.branchId) : undefined;

  return (
    <div className="composer" ref={box}>
      <div
        className={`composer-box ${dragOver ? 'drag-over' : ''}`}
        style={color ? { ['--branch' as any]: color } : undefined}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes('Files')) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragOver(false);
          addFiles([...e.dataTransfer.files]);
          ref.current?.focus();
        }}
      >
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
        {atts.length > 0 && (
          <div className="composer-atts">
            {atts.map((a) => (
              <span key={a.key} className={`catt ${a.preview ? 'img' : ''} ${a.att ? '' : 'up'}`} title={`${a.name} · ${fileSize(a.size)}`}>
                {a.preview ? <img src={a.preview} alt="" /> : <Icon name="file" size={14} />}
                {!a.preview && (
                  <span className="catt-text">
                    <span className="ellipsis">{a.name}</span>
                    <em>{fileSize(a.size)}</em>
                  </span>
                )}
                {!a.att && <span className="spinner" />}
                <button onClick={() => removeAtt(a.key)} aria-label={`Remove ${a.name}`} title="Remove">
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row">
          <button className="attach-btn" onClick={pick} onPointerDown={(e) => e.preventDefault()} aria-label="Attach images or files" title="Attach images or files (or paste / drop them here)">
            <Icon name="clip" size={17} />
          </button>
          <textarea
            ref={ref}
            value={text}
            rows={1}
            enterKeyHint={mobile ? 'enter' : 'send'}
            placeholder={targetBusy ? 'Agent is working. Type your next step…' : target ? 'What next?' : 'Describe a task for a new agent…'}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (!files.length) return;
              e.preventDefault();
              addFiles(files);
            }}
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
            disabled={!canSend} onClick={go} aria-label="Send" title={targetBusy ? 'Wait for the agent to finish' : uploading ? 'Attaching…' : 'Send (Enter)'}>
            {busy ? <span className="spinner light" /> : <Icon name="send" size={18} strokeWidth={2.25} />}
          </button>
        </div>
      </div>
    </div>
  );
}
