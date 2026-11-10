import { useEffect, useState } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'forkspace:theme';

export function getTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

const listeners = new Set<(t: Theme) => void>();

/** Apply before first paint (called from main.tsx) and whenever it changes. */
export function applyTheme(t: Theme = getTheme()) {
  const el = document.documentElement;
  if (t === 'system') delete el.dataset.theme;
  else el.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#0b0c10' : '#f6f6f8'));
}

export function setTheme(t: Theme) {
  try {
    t === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, t);
  } catch {}
  applyTheme(t);
  listeners.forEach((l) => l(t));
}

export function useTheme() {
  const [t, set] = useState<Theme>(getTheme());
  useEffect(() => {
    listeners.add(set);
    return () => void listeners.delete(set);
  }, []);
  return t;
}

/** The theme actually showing right now (resolves 'system'). */
export function useResolvedTheme(): 'light' | 'dark' {
  const t = useTheme();
  const [sysDark, setSysDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => {
      setSysDark(mq.matches);
      if (getTheme() === 'system') applyTheme('system');
    };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return t === 'system' ? (sysDark ? 'dark' : 'light') : t;
}
