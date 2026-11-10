import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { HOME } from './store.ts';

// One access key per install. Every client needs it to open the WebSocket.
// Pages opened directly on this Mac (http://localhost) get it automatically;
// other devices get it by scanning the pairing QR code.

const FILE = path.join(HOME, 'auth.json');

interface Auth {
  token: string;
  publicUrl?: string;
}

const newToken = () => crypto.randomBytes(24).toString('base64url');

function load(): Auth {
  try {
    const a = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Auth;
    if (a.token) return a;
  } catch {}
  return { token: newToken() };
}

const auth = load();
const persist = () => fs.writeFileSync(FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
persist();

export const getToken = () => auth.token;
export const getPublicUrl = () => auth.publicUrl;

export function setPublicUrl(url?: string) {
  auth.publicUrl = url?.trim().replace(/\/+$/, '') || undefined;
  persist();
}

export function rotateToken() {
  auth.token = newToken();
  persist();
  return auth.token;
}

export function checkToken(t: string | null | undefined): boolean {
  if (!t) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(auth.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'tailscale-user-login'];

/**
 * True only for a browser on this machine talking to us directly:
 * loopback socket, a localhost Host header (blocks DNS rebinding) and no proxy headers
 * (tunnels like Tailscale Serve or Cloudflare connect from loopback too).
 */
export function isLocalRequest(req: IncomingMessage): boolean {
  const ra = req.socket.remoteAddress ?? '';
  const loopback = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  const proxied = FORWARD_HEADERS.some((h) => req.headers[h] != null);
  return loopback && localHost && !proxied;
}

// ---- pairing codes ----
// A paired device trades a short-lived 6-digit code (shown on an already-signed-in screen) for the key.

const CODE_TTL = 5 * 60 * 1000;
const codes = new Map<string, number>(); // code -> expiresAt
let failures: number[] = [];

export function newPairCode() {
  let code: string;
  do code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  while (codes.has(code));
  const expiresAt = Date.now() + CODE_TTL;
  codes.set(code, expiresAt);
  return { code, expiresAt };
}

export function redeemPairCode(code: string): string {
  const now = Date.now();
  failures = failures.filter((t) => now - t < 60_000);
  if (failures.length >= 10) throw new Error('Too many attempts. Wait a minute and try again.');
  for (const [c, exp] of codes) if (exp < now) codes.delete(c);
  const clean = String(code ?? '').replace(/\D/g, '');
  if (!codes.has(clean)) {
    failures.push(now);
    throw new Error('That code is wrong or expired. Get a new one on your Mac.');
  }
  codes.delete(clean);
  return auth.token;
}
