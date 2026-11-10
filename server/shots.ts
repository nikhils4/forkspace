import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { nanoid } from 'nanoid';
import { HOME } from './store.ts';

// Screenshots on steps, so a thread shows at a glance what it was about.
// Stored as files in ~/.forkspace/shots; steps keep their ids. Taken automatically from the
// board's preview address with the Chrome already on this machine (headless, no new install),
// or pasted, dropped or picked by hand.

const run = promisify(execFile);
export const SHOTS = path.join(HOME, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const MAX_BYTES = 12 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{6,24}$/;

/** What kind of image these bytes are, from their first bytes (never trust a file name). */
function sniff(b: Buffer): 'png' | 'jpg' | 'webp' | 'gif' | null {
  if (b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  return null;
}

/** The media type of image bytes, or an error if they aren't an image. */
export function imageType(bytes: Buffer) {
  if (bytes.length > MAX_BYTES) throw new Error('That image is too big (12 MB at most).');
  const kind = sniff(bytes);
  if (!kind) throw new Error('That is not an image Forkspace can read (PNG, JPEG, WebP or GIF).');
  return TYPES[kind];
}

export function saveShot(bytes: Buffer): string {
  if (bytes.length > MAX_BYTES) throw new Error('That image is too big (12 MB at most).');
  const kind = sniff(bytes);
  if (!kind) throw new Error('That is not an image Forkspace can show (PNG, JPEG, WebP or GIF).');
  const id = nanoid(12);
  fs.writeFileSync(path.join(SHOTS, `${id}.${kind}`), bytes, { mode: 0o600 });
  return id;
}

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

export function readShot(id: string): { bytes: Buffer; type: string } | null {
  if (!ID.test(id)) return null;
  for (const ext of Object.keys(TYPES)) {
    const f = path.join(SHOTS, `${id}.${ext}`);
    if (fs.existsSync(f)) return { bytes: fs.readFileSync(f), type: TYPES[ext] };
  }
  return null;
}

export function deleteShot(id: string) {
  if (!ID.test(id)) return;
  for (const ext of Object.keys(TYPES)) fs.rmSync(path.join(SHOTS, `${id}.${ext}`), { force: true });
}

// ---- automatic: headless Chrome (or Edge, Brave, Chromium) ----

const BROWSERS =
  process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Arc.app/Contents/MacOS/Arc',
      ]
    : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];

export const browserFound = () => BROWSERS.find((b) => fs.existsSync(b)) ?? null;

/** Screenshot a page in a hidden browser window. Returns the new shot id. */
export async function capture(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error('The preview address must start with http:// or https://');
  const bin = browserFound();
  if (!bin) throw new Error('No Chrome, Edge or Brave found to take screenshots with.');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forkspace-shot-'));
  const file = path.join(tmp, 'shot.png');
  try {
    await run(
      bin,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${path.join(tmp, 'profile')}`,
        '--window-size=1280,800',
        '--virtual-time-budget=5000',
        `--screenshot=${file}`,
        url,
      ],
      { timeout: 45_000 },
    );
    if (!fs.existsSync(file)) throw new Error('The browser did not save a screenshot.');
    return saveShot(fs.readFileSync(file));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
