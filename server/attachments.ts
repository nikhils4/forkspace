import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { Attachment } from '../shared/types.ts';
import { imageType, readShot, saveShot, shotPath } from './shots.ts';
import { HOME } from './store.ts';

// Files you attach to a prompt. Images are kept with the screenshots (so they show on the card)
// and go to Claude as images; other files are kept here and Claude reads them from disk.

export const ATTACH = path.join(HOME, 'attachments');
fs.mkdirSync(ATTACH, { recursive: true });

const MAX_BYTES = 30 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{6,24}$/;
/** Largest image sent inline (the API takes about 5 MB once encoded). Bigger ones are read from disk. */
export const INLINE_IMAGE_MAX = 3_700_000;

const safeName = (name: string) => path.basename(name || 'file').replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '').slice(-120) || 'file';

export function saveAttachment(bytes: Buffer, name: string): Attachment {
  if (!bytes.length) throw new Error('That file is empty.');
  if (bytes.length > MAX_BYTES) throw new Error('That file is too big (30 MB at most).');
  const clean = safeName(name);
  let image = false;
  try {
    imageType(bytes);
    image = true;
  } catch {}
  if (image) return { id: saveShot(bytes), name: clean, kind: 'image', size: bytes.length };
  const id = nanoid(12);
  fs.mkdirSync(path.join(ATTACH, id), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(ATTACH, id, clean), bytes, { mode: 0o600 });
  return { id, name: clean, kind: 'file', size: bytes.length };
}

/** Where an attachment lives on disk, or null if it's gone or the record is not one of ours. */
export function attachmentPath(a: Attachment): string | null {
  if (!ID.test(a.id)) return null;
  if (a.kind === 'image') return shotPath(a.id);
  const f = path.join(ATTACH, a.id, safeName(a.name));
  return fs.existsSync(f) ? f : null;
}

/** Keep only well-formed attachments that really exist (the client could send anything). */
export function checkAttachments(list: unknown): Attachment[] {
  if (!Array.isArray(list)) return [];
  const out: Attachment[] = [];
  for (const x of list.slice(0, 20)) {
    if (!x || typeof x !== 'object') continue;
    const a: Attachment = { id: String((x as any).id), name: safeName(String((x as any).name ?? '')), kind: (x as any).kind === 'image' ? 'image' : 'file', size: Number((x as any).size) || 0 };
    if (attachmentPath(a)) out.push(a);
  }
  return out;
}

export function deleteAttachment(a: Attachment) {
  if (!ID.test(a.id) || a.kind === 'image') return;
  fs.rmSync(path.join(ATTACH, a.id), { recursive: true, force: true });
}

export const imageBytes = (a: Attachment) => readShot(a.id);
