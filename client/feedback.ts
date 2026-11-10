import { currentUpdate } from './Updates.tsx';

// Feedback goes to GitHub, prefilled. Nothing is sent from Forkspace itself: the person
// reviews the issue on GitHub and submits it with their own account.

const REPO = 'https://github.com/nikhils4/forkspace';

/** "macOS · Chrome 141 · installed app" from the user agent; no IDs, nothing personal. */
export function whereAmI() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const b = ua.match(/(Edg|Firefox|Chrome|CriOS|Version)\/(\d+)/);
  const browser = b ? `${{ Edg: 'Edge', Firefox: 'Firefox', Chrome: 'Chrome', CriOS: 'Chrome', Version: 'Safari' }[b[1]]} ${b[2]}` : 'Browser';
  const app = matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone ? 'installed app' : 'browser tab';
  return `${os} · ${browser} · ${app}`;
}

export function bugReportUrl(opts: { title?: string; what?: string; details?: string } = {}) {
  const q = new URLSearchParams({ template: 'bug_report.yml', labels: 'bug' });
  if (opts.title) q.set('title', opts.title.slice(0, 120));
  if (opts.what) q.set('what', opts.what);
  q.set('version', currentUpdate()?.version ?? '');
  q.set('where', whereAmI());
  // Keep the link short enough for every browser.
  if (opts.details) q.set('details', opts.details.slice(0, 3000));
  return `${REPO}/issues/new?${q}`;
}

export const ideaUrl = () => `${REPO}/issues/new?template=feature_request.yml&labels=idea`;
export const questionUrl = () => `${REPO}/discussions/new?category=q-a`;
