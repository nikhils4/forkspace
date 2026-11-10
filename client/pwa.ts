import { useEffect, useState } from 'react';
import { request } from './store.ts';

// ---- service worker ----
export function registerSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---- install prompt (Chrome / Edge desktop + Android) ----
let deferred: any = null;
const installListeners = new Set<() => void>();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  installListeners.forEach((l) => l());
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  installListeners.forEach((l) => l());
});

export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    installListeners.add(l);
    return () => void installListeners.delete(l);
  }, []);
  return {
    canPrompt: !!deferred && !isStandalone(),
    prompt: async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice.catch(() => {});
      deferred = null;
      installListeners.forEach((l) => l());
    },
  };
}

// ---- push notifications ----
export type PushSupport = 'ok' | 'insecure' | 'unsupported' | 'ios-install';

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure';
  if (isIOS() && !isStandalone()) return 'ios-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'ok';
}

function b64ToBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function pushEnabled(): Promise<boolean> {
  if (pushSupport() !== 'ok') return false;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return false;
  return request<boolean>({ type: 'pushStatus', endpoint: sub.endpoint }).catch(() => false);
}

export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications are blocked. Allow them in your browser or system settings.');
  const reg = await navigator.serviceWorker.ready;
  const key = await request<string>({ type: 'pushKey' });
  let sub = await reg.pushManager.getSubscription();
  if (!sub)
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }).catch(() => {
      throw new Error('This browser refused push notifications. Check that notifications are allowed for Forkspace in your browser and system settings.');
    });
  await request({ type: 'pushSubscribe', subscription: sub.toJSON() });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await request({ type: 'pushUnsubscribe', endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
