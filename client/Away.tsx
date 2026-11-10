import { useEffect, useState } from 'react';
import type { AwayInfo, RemoteInfo } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { Notifications, PairPanel, Step } from './Settings.tsx';
import { isLocalPage, request, toast, useStore } from './store.ts';
import { Switch } from './ui.tsx';

// Away mode: keep this computer awake and reachable while you're gone,
// and walk through getting the phone connected if it isn't yet.

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

let shared: AwayInfo | null = null;
const subs = new Set<(i: AwayInfo) => void>();
const publish = (i: AwayInfo) => {
  shared = i;
  subs.forEach((f) => f(i));
};

/** Away status, refreshed every few seconds while something shows it. */
export function useAway(every = 4000) {
  const { connected } = useStore();
  const [info, setInfo] = useState<AwayInfo | null>(shared);
  useEffect(() => {
    subs.add(setInfo);
    return () => void subs.delete(setInfo);
  }, []);
  useEffect(() => {
    if (!connected) return;
    const load = () => request<AwayInfo>({ type: 'awayInfo' }).then(publish, () => {});
    load();
    const id = setInterval(load, every);
    return () => clearInterval(id);
  }, [connected, every]);
  return info;
}

export function AwaySection() {
  const info = useAway(3000);
  const local = isLocalPage();
  const [busy, setBusy] = useState(false);

  const set = async (on: boolean, screen?: boolean) => {
    setBusy(true);
    try {
      publish(await request<AwayInfo>({ type: 'setAway', on, screen }));
      if (screen === undefined) toast(on ? 'Away mode on. This computer stays awake.' : 'Away mode off');
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setBusy(false);
  };

  if (!info)
    return (
      <section className="card-section away">
        <h3>
          <Icon name="moon" size={16} /> Away mode
        </h3>
        <div className="faint">Checking…</div>
      </section>
    );

  const a = info.away;
  const ts = info.tailscale;
  const phoneSeen = a.remoteConnected > 0 || !!a.remoteSeen;
  const mac = a.platform === 'darwin';
  const computer = mac ? 'Mac' : 'computer';

  return (
    <section className={`card-section away ${a.on ? 'is-on' : ''}`}>
      <h3>
        <Icon name="moon" size={16} /> Away mode
      </h3>
      <div className="setting-row">
        <div className="setting-text">
          <b>{a.on ? `On${a.since ? ` since ${ago(a.since)}` : ''}` : 'Keep this ' + computer + ' awake'}</b>
          <span>
            {!a.supported
              ? 'Not available on this system.'
              : a.on
                ? `Your ${computer} won't sleep while Forkspace runs, so agents keep working and your phone can reach it.`
                : `Turn on before you step away. Your ${computer} won't sleep, agents keep working, and you can check in from your phone.`}
          </span>
        </div>
        <Switch on={a.on} disabled={!a.supported || busy} onChange={(v) => set(v)} />
      </div>
      {a.on && (
        <div className="setting-row">
          <div className="setting-text">
            <b>Keep the screen on too</b>
            <span>Off saves power. Agents don't need the screen.</span>
          </div>
          <Switch on={a.screen} disabled={busy} onChange={(v) => set(true, v)} />
        </div>
      )}
      {a.on && !a.active && a.error && <div className="error-box">{a.error}</div>}
      {a.on && a.onBattery && <div className="warn-box">On battery, macOS can still sleep. Plug in to power for away mode to hold.</div>}
      {a.on && mac && <p className="faint small">Leave the lid open. A closed MacBook sleeps unless it's plugged into power and a display.</p>}

      <div className="away-phone">
        <Icon name="phone" size={14} />
        {a.remoteConnected > 0 ? (
          <span>
            <b>Phone connected now.</b> {local ? 'You can walk away.' : 'This is it.'}
          </span>
        ) : a.remoteSeen ? (
          <span>
            {a.remoteSeen.device === 'device' ? 'A device' : `Your ${a.remoteSeen.device}`} last connected {ago(a.remoteSeen.at)}.
          </span>
        ) : (
          <span>No phone connected yet. Set it up below.</span>
        )}
      </div>

      {!local ? (
        <Notifications />
      ) : (
        <details className="away-setup" open={!phoneSeen || !ts.serving || info.pushDevices === 0}>
          <summary>{phoneSeen && ts.serving && info.pushDevices > 0 ? 'Phone setup: done' : 'Set up your phone, step by step'}</summary>
          <PhoneSteps info={info} />
        </details>
      )}
    </section>
  );
}

function PhoneSteps({ info }: { info: AwayInfo }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const ts = info.tailscale;
  const a = info.away;
  const phoneSeen = a.remoteConnected > 0 || !!a.remoteSeen;
  const base = ts.serving ? ts.url : info.publicUrl;
  const refresh = () => request<AwayInfo>({ type: 'awayInfo' }).then(publish, () => {});
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setErr('');
    try {
      await fn();
    } catch (e: any) {
      // Turning on the background service hands over to a new process; the page reconnects by itself.
      if (!/Disconnected/.test(e.message)) setErr(e.message);
    }
    setBusy('');
    refresh();
  };
  let n = 0;
  return (
    <div className="steps">
      <Step n={++n} done={info.service.installed} title="Keep Forkspace running without the terminal">
        {!info.service.installed &&
          (info.service.supported ? (
            <>
              <p className="faint">So a closed terminal window doesn't stop your agents. Starts again at login, too.</p>
              <button className="btn" disabled={!!busy} onClick={() => act('svc', () => request({ type: 'serviceEnable' }))}>
                {busy === 'svc' ? 'Turning on…' : 'Turn on'}
              </button>
            </>
          ) : (
            <p className="faint">{info.service.reason ?? 'Not available here.'} Keep the terminal window open while you're away.</p>
          ))}
      </Step>
      <Step n={++n} done={ts.installed} title="Install Tailscale on this computer">
        {!ts.installed && (
          <>
            <p className="faint">A free private network between your own devices. Nothing is opened to the internet.</p>
            <div className="row-wrap">
              <a className="btn" href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                <Icon name="external" size={14} /> Get Tailscale
              </a>
              <button className="btn ghost" onClick={refresh}>
                <Icon name="refresh" size={14} /> Check again
              </button>
            </div>
          </>
        )}
      </Step>
      <Step n={++n} done={ts.running} title="Sign in to Tailscale">
        {ts.installed && !ts.running && <p className="faint">Open Tailscale from the menu bar and sign in. This list updates on its own.</p>}
      </Step>
      <Step n={++n} done={ts.serving} title="Turn on phone access">
        {ts.running && !ts.serving && (
          <button className="btn primary" disabled={!!busy} onClick={() => act('serve', () => request<RemoteInfo>({ type: 'enableTailscale' }))}>
            {busy === 'serve' ? 'Turning on…' : 'Turn on'}
          </button>
        )}
        {ts.serving && ts.url && <div className="mono faint small">{ts.url}</div>}
      </Step>
      <Step n={++n} done={phoneSeen} title="Install Tailscale on your phone, same account">
        {!phoneSeen && (
          <div className="row-wrap">
            <a className="btn sm" href="https://apps.apple.com/app/tailscale/id1470499037" target="_blank" rel="noreferrer">
              iPhone
            </a>
            <a className="btn sm" href="https://play.google.com/store/apps/details?id=com.tailscale.ipn" target="_blank" rel="noreferrer">
              Android
            </a>
            <span className="faint small">Sign in with the same account as this computer and switch it on.</span>
          </div>
        )}
      </Step>
      <Step n={++n} done={phoneSeen} title="Scan this with your phone">
        {!phoneSeen && base && (
          <>
            <PairPanel base={base} />
            <p className="faint small">On iPhone, tap Share then Add to Home Screen, and open Forkspace from there. That's what lets it send notifications.</p>
          </>
        )}
        {!phoneSeen && !base && <p className="faint small">Finish the steps above and a code appears here.</p>}
      </Step>
      <Step n={++n} done={info.pushDevices > 0} title="Turn on notifications on your phone">
        {info.pushDevices === 0 && <p className="faint small">On the phone: Settings, then Notifications on this device. You'll get a ping when an agent needs you or finishes.</p>}
      </Step>
      {err && <div className="error-box">{err}</div>}
    </div>
  );
}

/** Sidebar link: shows at a glance whether away mode is on. */
export function AwayLink({ onOpen }: { onOpen: () => void }) {
  const info = useAway(15000);
  const on = !!info?.away.on;
  return (
    <button className={`side-link ${on ? 'away-on' : ''}`} onClick={onOpen}>
      <Icon name="moon" size={16} /> Away mode
      <span className="spacer" />
      {on && <span className="away-dot" title="On" />}
    </button>
  );
}
