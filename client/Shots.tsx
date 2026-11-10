import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { getToken, request, send, toast } from './store.ts';

// Screenshots on steps: load them with the access key, show a preview, open them big.

const urls = new Map<string, Promise<string>>();

/** An object URL for a stored screenshot (images need the access key, so they're fetched). */
export function useShot(id: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return setUrl(null);
    let alive = true;
    if (!urls.has(id))
      urls.set(
        id,
        fetch(`/api/shots/${id}`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } })
          .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('missing'))))
          .then((b) => URL.createObjectURL(b))
          .catch((e) => {
            urls.delete(id);
            throw e;
          }),
      );
    urls.get(id)!.then(
      (u) => alive && setUrl(u),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [id]);
  return url;
}

export async function uploadShot(nodeId: string, file: Blob) {
  if (!file.type.startsWith('image/')) throw new Error('That is not an image.');
  const r = await fetch(`/api/shots?node=${encodeURIComponent(nodeId)}`, { method: 'POST', body: file, headers: { authorization: `Bearer ${getToken() ?? ''}` } });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? 'Could not save the screenshot.');
  toast('Screenshot added');
}

/** Pick an image file and attach it to a step. */
export function pickShot(nodeId: string) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/webp,image/gif';
  input.onchange = () => {
    const f = input.files?.[0];
    if (f) uploadShot(nodeId, f).catch((e: Error) => toast(e.message, 'error'));
  };
  input.click();
}

export async function snapPreview(nodeId: string) {
  toast('Taking a screenshot of your app…');
  try {
    await request({ type: 'captureShot', nodeId });
    toast('Screenshot added');
  } catch (e: any) {
    toast(e.message, 'error');
  }
}

export function ShotThumb({ id, className = '', onOpen, count }: { id: string; className?: string; onOpen: () => void; count?: number }) {
  const url = useShot(id);
  return (
    <button
      className={`shot-thumb nodrag ${className} ${url ? '' : 'loading'}`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title="Open screenshot"
    >
      {url && <img src={url} alt="Screenshot" draggable={false} />}
      {count && count > 1 ? <span className="shot-count">{count}</span> : null}
    </button>
  );
}

// ---- full-size viewer, shared by every preview ----
type Open = { shots: { id: string; node: TurnNode }[]; at: number } | null;
let openState: Open = null;
const subs = new Set<(o: Open) => void>();
export function openShots(shots: { id: string; node: TurnNode }[], at = shots.length - 1) {
  openState = { shots, at };
  subs.forEach((f) => f(openState));
}

export function ShotViewer() {
  const [o, setO] = useState<Open>(openState);
  useEffect(() => {
    subs.add(setO);
    return () => void subs.delete(setO);
  }, []);
  const cur = o ? o.shots[o.at] : null;
  const url = useShot(cur?.id);
  useEffect(() => {
    if (!o) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setO(null);
      }
      if (e.key === 'ArrowLeft') setO((x) => x && { ...x, at: Math.max(0, x.at - 1) });
      if (e.key === 'ArrowRight') setO((x) => x && { ...x, at: Math.min(x.shots.length - 1, x.at + 1) });
    };
    addEventListener('keydown', k, true);
    return () => removeEventListener('keydown', k, true);
  }, [!!o]);
  if (!o || !cur) return null;
  return createPortal(
    <div className="shot-viewer" onClick={() => setO(null)}>
      <div className="shot-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="ellipsis">{cur.node.prompt}</span>
        <span className="faint small">
          {o.at + 1} of {o.shots.length}
        </span>
        <button
          className="icon-btn"
          title="Remove this screenshot"
          aria-label="Remove screenshot"
          onClick={() => {
            send({ type: 'removeShot', nodeId: cur.node.id, shotId: cur.id });
            const rest = o.shots.filter((s) => s.id !== cur.id);
            setO(rest.length ? { shots: rest, at: Math.min(o.at, rest.length - 1) } : null);
          }}
        >
          <Icon name="trash" size={15} />
        </button>
        <button className="icon-btn" onClick={() => setO(null)} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>
      {o.at > 0 && (
        <button className="shot-nav left" onClick={(e) => (e.stopPropagation(), setO({ ...o, at: o.at - 1 }))} aria-label="Previous">
          <Icon name="chevronLeft" size={22} />
        </button>
      )}
      {url ? <img src={url} alt="Screenshot" onClick={(e) => e.stopPropagation()} /> : <span className="spinner" />}
      {o.at < o.shots.length - 1 && (
        <button className="shot-nav right" onClick={(e) => (e.stopPropagation(), setO({ ...o, at: o.at + 1 }))} aria-label="Next">
          <Icon name="chevronRight" size={22} />
        </button>
      )}
    </div>,
    document.body,
  );
}
