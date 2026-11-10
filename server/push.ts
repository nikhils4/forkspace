import fs from 'node:fs';
import path from 'node:path';
import webpush, { type PushSubscription } from 'web-push';
import { HOME } from './store.ts';

const FILE = path.join(HOME, 'push.json');

interface PushState {
  publicKey: string;
  privateKey: string;
  subs: PushSubscription[];
}

function load(): PushState {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8')) as PushState;
    if (s.publicKey && s.privateKey) return { ...s, subs: s.subs ?? [] };
  } catch {}
  const keys = webpush.generateVAPIDKeys();
  return { ...keys, subs: [] };
}

const ps = load();
const persist = () => fs.writeFileSync(FILE, JSON.stringify(ps, null, 2), { mode: 0o600 });
persist();

webpush.setVapidDetails('mailto:forkspace@example.com', ps.publicKey, ps.privateKey);

export const publicKey = () => ps.publicKey;
export const subscriptionCount = () => ps.subs.length;
/** Signing out other devices: they must not keep getting notifications either. */
export function clearSubscriptions() {
  ps.subs = [];
  persist();
}

export function subscribe(sub: PushSubscription) {
  if (!sub?.endpoint) throw new Error('Bad subscription');
  ps.subs = ps.subs.filter((s) => s.endpoint !== sub.endpoint);
  ps.subs.push(sub);
  persist();
}

export function unsubscribe(endpoint: string) {
  ps.subs = ps.subs.filter((s) => s.endpoint !== endpoint);
  persist();
}

export const hasSubscription = (endpoint: string) => ps.subs.some((s) => s.endpoint === endpoint);

export async function notify(payload: { title: string; body: string; tag: string; url: string }) {
  await Promise.all(
    ps.subs.map((s) =>
      webpush.sendNotification(s, JSON.stringify(payload), { TTL: 3600, urgency: 'high' }).catch((err: any) => {
        // Gone or expired: forget it.
        if (err?.statusCode === 404 || err?.statusCode === 410) unsubscribe(s.endpoint);
      }),
    ),
  );
}
