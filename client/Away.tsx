import { useEffect, useMemo, useRef, useState } from 'react';
import type { AwayInfo, RemoteInfo, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { PairPanel } from './Settings.tsx';
import { isLocalPage, request, toast, useStore } from './store.ts';
import { currentActivity, isLive, isTurn, plain } from './tree.ts';
import { Switch } from './ui.tsx';

// Away mode: this computer stays awake while you're gone. The away screen is what you leave
// on it: a calm wallpaper, the time, what your agents are doing, and (only if needed) a gentle
// walk-through to bring your phone along.

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

// ---- shared away status ----
let shared: AwayInfo | null = null;
const subs = new Set<(i: AwayInfo) => void>();
const publish = (i: AwayInfo) => {
  shared = i;
  subs.forEach((f) => f(i));
};
export const refreshAway = () => request<AwayInfo>({ type: 'awayInfo' }).then(publish, () => {});

export function useAway(every = 4000) {
  const { connected } = useStore();
  const [info, setInfo] = useState<AwayInfo | null>(shared);
  useEffect(() => {
    subs.add(setInfo);
    return () => void subs.delete(setInfo);
  }, []);
  useEffect(() => {
    if (!connected) return;
    refreshAway();
    const id = setInterval(refreshAway, every);
    return () => clearInterval(id);
  }, [connected, every]);
  return info;
}

async function setAway(on: boolean, screen?: boolean) {
  try {
    publish(await request<AwayInfo>({ type: 'setAway', on, screen }));
  } catch (e: any) {
    toast(e.message, 'error');
  }
}

// ---- the screen's open state ----
let screenOpen = false;
let autoShown = false;
const screenSubs = new Set<(v: boolean) => void>();
const setScreen = (v: boolean) => {
  screenOpen = v;
  screenSubs.forEach((f) => f(v));
};
export function useAwayScreen() {
  const [open, setOpen] = useState(screenOpen);
  useEffect(() => {
    screenSubs.add(setOpen);
    return () => void screenSubs.delete(setOpen);
  }, []);
  return open;
}
/** Turn away mode on and show the away screen. */
export async function goAway() {
  setScreen(true);
  document.documentElement.requestFullscreen?.().catch(() => {});
  if (!shared?.away.on) await setAway(true);
}

// ---- Settings: a short section, the screen does the rest ----
export function AwaySection() {
  const info = useAway(5000);
  const a = info?.away;
  const mac = a?.platform === 'darwin';
  return (
    <section className="card-section">
      <h3>
        <Icon name="moon" size={16} /> Away mode
      </h3>
      <div className="setting-row">
        <div className="setting-text">
          <b>{a?.on ? `On since ${a.since ? ago(a.since) : 'now'}` : `Keep this ${mac ? 'Mac' : 'computer'} awake`}</b>
          <span>{a && !a.supported ? 'Not available on this system.' : 'Agents keep working while you’re gone, and your phone can always reach them.'}</span>
        </div>
        <Switch on={!!a?.on} disabled={!a?.supported} onChange={(v) => setAway(v)} />
      </div>
      {a?.on && (
        <div className="setting-row">
          <div className="setting-text">
            <b>Keep the screen on too</b>
            <span>Off saves power. Agents don't need the screen.</span>
          </div>
          <Switch on={a.screen} onChange={(v) => setAway(true, v)} />
        </div>
      )}
      {isLocalPage() && (
        <button className="btn sm self-start" onClick={goAway}>
          <Icon name="moon" size={13} /> Open the away screen
        </button>
      )}
    </section>
  );
}

/** Sidebar entry: one click and you're away. */
export function AwayLink() {
  const info = useAway(15000);
  const on = !!info?.away.on;
  return (
    <button className={`side-link ${on ? 'away-on' : ''}`} onClick={goAway} title="Keep this computer awake and show the away screen">
      <Icon name="moon" size={15} /> Away mode
      <span className="spacer" />
      {on && <span className="away-dot" title="On" />}
    </button>
  );
}

// ---- the away screen ----

const QUIET = [
  'All quiet. Nothing needs you.',
  'Start something before you go, or just enjoy the quiet.',
  'Go get a coffee. Your phone will buzz if anything needs you.',
  'This computer is staying awake.',
  'Your code stays right here.',
  'Stretch. Seriously.',
  'Every change waits for you, diffed and explained.',
];

type Line = { id: string; text: string; sub?: string; tone?: 'done' | 'need' | 'learn' };

export function AwayScreen({ onGoTo }: { onGoTo: (t: TurnNode) => void }) {
  const open = useAwayScreen();
  const info = useAway(4000);
  const store = useStore();
  const [now, setNow] = useState(Date.now());
  const [quiet, setQuiet] = useState(0);
  const [feed, setFeed] = useState<Line[]>([]);
  const [setup, setSetup] = useState(false);
  const last = useRef(new Map<string, string>());
  const openedAt = useRef(Date.now());

  useEffect(() => {
    if (!open) return;
    openedAt.current = info?.away.since ?? Date.now();
    const id = setInterval(() => setNow(Date.now()), 1000);
    const q = setInterval(() => setQuiet((x) => x + 1), 9000);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    addEventListener('keydown', key);
    return () => {
      clearInterval(id);
      clearInterval(q);
      removeEventListener('keydown', key);
    };
  }, [open]);

  // Opening Forkspace on this computer while away mode is on lands you on the away screen.
  useEffect(() => {
    if (!autoShown && info?.away.on && isLocalPage()) {
      autoShown = true;
      setScreen(true);
    }
    if (info && !info.away.on) autoShown = true;
  }, [info?.away.on]);

  // Keep the screen lit while it shows, when asked to.
  useEffect(() => {
    if (!open || !info?.away.screen || !('wakeLock' in navigator)) return;
    let lock: any;
    (navigator as any).wakeLock.request('screen').then((l: any) => (lock = l), () => {});
    return () => lock?.release?.();
  }, [open, info?.away.screen]);

  // A live feed of what agents are doing, built from changes as they arrive.
  const boards = useMemo(() => Object.fromEntries(store.boards.map((b) => [b.id, b.name])), [store.boards]);
  useEffect(() => {
    if (!open) return;
    const add: Line[] = [];
    for (const n of Object.values(store.nodes)) {
      if (!isTurn(n)) continue;
      const lessons = n.lessons ?? [];
      const sig = `${n.status}|${n.events.length}|${lessons.length}`;
      const prev = last.current.get(n.id);
      last.current.set(n.id, sig);
      if (prev === undefined || prev === sig) continue;
      const where = boards[n.boardId] ?? 'Forkspace';
      const newest = lessons[lessons.length - 1];
      if (newest && !prev.endsWith(`|${lessons.length}`)) add.push({ id: `${n.id}-l${lessons.length}`, text: newest.title, sub: `Concept · ${where}`, tone: 'learn' });
      if (n.status === 'waiting' && !prev.startsWith('waiting')) add.push({ id: `${n.id}-w${n.events.length}`, text: `Needs you: ${n.pending?.toolName ?? 'a decision'}`, sub: where, tone: 'need' });
      else if (n.status === 'done' && !prev.startsWith('done')) add.push({ id: `${n.id}-d`, text: `Done: ${plain(n.prompt).slice(0, 70)}`, sub: where, tone: 'done' });
      else if (isLive(n)) add.push({ id: `${n.id}-${n.events.length}`, text: currentActivity(n).slice(0, 90), sub: where });
    }
    if (add.length) setFeed((f) => [...f, ...add].slice(-6));
  }, [store.nodes, open]);

  if (!open || !info) return null;
  const a = info.away;
  const turns = Object.values(store.nodes).filter(isTurn) as TurnNode[];
  const working = turns.filter((t) => t.status === 'running').length;
  const needs = turns.filter((t) => t.status === 'waiting');
  const since = openedAt.current;
  const finished = turns.filter((t) => t.status === 'done' && (t.finishedAt ?? 0) > since).length;
  const learned = turns.reduce((s, t) => s + (t.lessons ?? []).filter((l) => l.at > since).length, 0);
  const phone = a.remoteConnected > 0;
  const mac = a.platform === 'darwin' ? 'Mac' : 'computer';
  const d = new Date(now);

  function close() {
    setScreen(false);
    setSetup(false);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  const back = async () => {
    close();
    await setAway(false);
    const bits = [finished && `${finished} step${finished === 1 ? '' : 's'} finished`, learned && `${learned} new concept${learned === 1 ? '' : 's'}`, needs.length && `${needs.length} waiting for you`].filter(Boolean);
    toast(bits.length ? `Welcome back. ${bits.join(', ')}.` : 'Welcome back. All quiet while you were gone.');
  };

  return (
    <div className="away-screen" role="dialog" aria-label="Away mode">
      <div className="aw-wall" aria-hidden>
        <i className="b1" />
        <i className="b2" />
        <i className="b3" />
      </div>

      <div className="aw-top">
        <span className="aw-brand">
          <Icon name="moon" size={14} /> Away
        </span>
        <span className="spacer" />
        <button className="aw-ghost" onClick={close} title="Hide this screen. Away mode stays on (Esc)">
          Hide
        </button>
      </div>

      {!setup ? (
        <div className="aw-center">
          <div className="aw-time">{d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
          <div className="aw-date">{d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
          <div className="aw-line" key={working || needs.length ? 'busy' : quiet}>
            {needs.length
              ? `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} you.`
              : working
                ? `${working} agent${working === 1 ? ' is' : 's are'} working. Your ${mac} is staying awake.`
                : QUIET[quiet % QUIET.length]}
          </div>
          <div className="aw-chips">
            <span className={`aw-chip ${a.active ? 'ok' : 'warn'}`}>
              <i /> {a.active ? `${mac} awake` : a.error ?? 'Starting…'}
            </span>
            {a.onBattery && (
              <span className="aw-chip warn">
                <i /> On battery, plug in
              </span>
            )}
            <span className={`aw-chip ${phone ? 'ok' : ''}`}>
              <i /> {phone ? 'Phone connected' : a.remoteSeen ? `Phone seen ${ago(a.remoteSeen.at)}` : 'No phone yet'}
            </span>
            {(finished > 0 || learned > 0) && (
              <span className="aw-chip">
                <i /> {[finished && `${finished} done`, learned && `${learned} learned`].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          {needs.length > 0 && (
            <button
              className="aw-need"
              onClick={() => {
                close();
                onGoTo(needs[0]);
              }}
            >
              Open it <Icon name="chevronRight" size={14} />
            </button>
          )}
          {!phone && !a.remoteSeen && isLocalPage() && (
            <button className="aw-soft" onClick={() => setSetup(true)}>
              <Icon name="phone" size={14} /> Bring your phone along
            </button>
          )}
        </div>
      ) : (
        <PhoneFlow info={info} onDone={() => setSetup(false)} />
      )}

      <div className="aw-bottom">
        <div className="aw-feed" aria-live="polite">
          {feed.map((l, i) => (
            <div key={l.id} className={`aw-feed-line ${l.tone ?? ''}`} style={{ opacity: 0.35 + (0.65 * (i + 1)) / feed.length }}>
              <span>{l.text}</span>
              {l.sub && <em>{l.sub}</em>}
            </div>
          ))}
        </div>
        <button className="aw-back" onClick={back}>
          I'm back
        </button>
      </div>
    </div>
  );
}

/** One step at a time, big and calm. Each step finishes itself when the computer notices. */
function PhoneFlow({ info, onDone }: { info: AwayInfo; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ts = info.tailscale;
  const phone = info.away.remoteConnected > 0 || !!info.away.remoteSeen;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (e: any) {
      if (!/Disconnected/.test(e.message)) setErr(e.message);
    }
    setBusy(false);
    refreshAway();
  };

  const steps = [
    {
      done: info.service.installed || !info.service.supported,
      title: 'Keep Forkspace running on its own',
      text: 'So closing the terminal never stops your agents.',
      action: (
        <button className="aw-primary" disabled={busy} onClick={() => act(() => request({ type: 'serviceEnable' }))}>
          {busy ? 'Turning on…' : 'Turn on'}
        </button>
      ),
    },
    {
      done: ts.installed,
      title: 'Get Tailscale on this computer',
      text: 'A free, private link between your own devices. Nothing opens to the internet.',
      action: (
        <a className="aw-primary" href="https://tailscale.com/download" target="_blank" rel="noreferrer">
          Download Tailscale
        </a>
      ),
    },
    { done: ts.running, title: 'Sign in to Tailscale', text: 'Open it from the menu bar and sign in. This moves on by itself.', action: null },
    {
      done: ts.serving,
      title: 'Let your phone in',
      text: 'Forkspace becomes reachable from your own devices, over HTTPS.',
      action: (
        <button className="aw-primary" disabled={busy} onClick={() => act(() => request<RemoteInfo>({ type: 'enableTailscale' }))}>
          {busy ? 'Turning on…' : 'Turn on'}
        </button>
      ),
    },
    {
      done: phone,
      title: 'On your phone',
      text: 'Install Tailscale, sign in with the same account, then scan this.',
      action: (
        <div className="aw-pair">
          {ts.url && <PairPanel base={ts.url} />}
          <div className="aw-stores">
            <a href="https://apps.apple.com/app/tailscale/id1470499037" target="_blank" rel="noreferrer">
              Tailscale for iPhone
            </a>
            <a href="https://play.google.com/store/apps/details?id=com.tailscale.ipn" target="_blank" rel="noreferrer">
              for Android
            </a>
          </div>
        </div>
      ),
    },
    {
      done: info.pushDevices > 0,
      title: 'Turn on notifications',
      text: 'On the phone: Settings, then Notifications. On iPhone, add Forkspace to the Home Screen first.',
      action: null,
    },
  ];
  const at = steps.findIndex((s) => !s.done);
  const step = steps[at];

  useEffect(() => {
    if (at < 0) {
      const t = setTimeout(onDone, 2500);
      return () => clearTimeout(t);
    }
  }, [at]);

  return (
    <div className="aw-center aw-flow">
      <div className="aw-dots">
        {steps.map((s, i) => (
          <i key={i} className={s.done ? 'done' : i === at ? 'on' : ''} />
        ))}
      </div>
      {step ? (
        <div className="aw-step" key={at}>
          <div className="aw-step-n">
            Step {at + 1} of {steps.length}
          </div>
          <h2>{step.title}</h2>
          <p>{step.text}</p>
          {step.action}
          {err && <div className="aw-err">{err}</div>}
        </div>
      ) : (
        <div className="aw-step">
          <h2>Your phone is with you.</h2>
          <p>Go. It will buzz when an agent needs you.</p>
        </div>
      )}
      <button className="aw-ghost" onClick={onDone}>
        {step ? 'Not now' : 'Close'}
      </button>
    </div>
  );
}
