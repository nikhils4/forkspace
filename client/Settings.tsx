import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import type { RemoteInfo } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { disablePush, enablePush, isIOS, isStandalone, pushEnabled, pushSupport, useInstall } from './pwa.ts';
import { isLocalPage, request, setToken, toast } from './store.ts';
import { Switch } from './ui.tsx';
import { UpdateSection } from './Updates.tsx';
import { StartCommand } from './Gate.tsx';
import { setTheme, useTheme, type Theme } from './theme.ts';
import { bugReportUrl, ideaUrl, questionUrl } from './feedback.ts';
import { Segmented } from './ui.tsx';
import { MoveSection } from './Transfer.tsx';

function Step({ n, done, title, children }: { n: number; done?: boolean; title: string; children?: React.ReactNode }) {
  return (
    <div className={`step ${done ? 'done' : ''}`}>
      <div className="step-n">{done ? <Icon name="check" size={13} strokeWidth={2.5} /> : n}</div>
      <div className="step-body">
        <div className="step-title">{title}</div>
        {children}
      </div>
    </div>
  );
}

function RemoteAccess({ info, setInfo }: { info: RemoteInfo | null; setInfo: (i: RemoteInfo) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [custom, setCustom] = useState(false);
  const [url, setUrl] = useState('');

  const refresh = () => request<RemoteInfo>({ type: 'remoteInfo' }).then(setInfo, (e) => setErr(e.message));
  if (!info) return <div className="faint">Checking…</div>;
  const ts = info.tailscale;

  return (
    <div className="steps">
      <Step n={1} done={ts.installed} title="Install Tailscale on this Mac and your phone">
        {!ts.installed && (
          <>
            <p className="faint">A free private network between your own devices. Nothing is exposed to the internet.</p>
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
      <Step n={2} done={ts.running} title="Sign in to the same account on both">
        {ts.installed && !ts.running && (
          <div className="row-wrap">
            <span className="faint">Open Tailscale on this Mac and sign in.</span>
            <button className="btn ghost" onClick={refresh}>
              <Icon name="refresh" size={14} /> Check again
            </button>
          </div>
        )}
      </Step>
      <Step n={3} done={ts.serving} title="Turn on phone access">
        {ts.running && !ts.serving && (
          <>
            <p className="faint">Serves Forkspace over HTTPS to your tailnet only.</p>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setErr('');
                try {
                  setInfo(await request<RemoteInfo>({ type: 'enableTailscale' }));
                } catch (e: any) {
                  setErr(e.message);
                }
                setBusy(false);
              }}
            >
              {busy ? 'Turning on…' : 'Turn on'}
            </button>
          </>
        )}
        {ts.serving && ts.url && <div className="mono accent-text">{ts.url}</div>}
      </Step>
      {err && <div className="error-box">{err}</div>}

      <button className="link-btn" onClick={() => setCustom(!custom)}>
        {custom ? 'Hide' : 'Using a different tunnel? Set your own address'}
      </button>
      {custom && (
        <div className="row">
          <input placeholder="https://forkspace.example.com" value={url || info.publicUrl || ''} autoCapitalize="off" onChange={(e) => setUrl(e.target.value)} />
          <button className="btn" onClick={() => request<RemoteInfo>({ type: 'setPublicUrl', url }).then(setInfo, (e) => setErr(e.message))}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function PairPanel({ base }: { base?: string }) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [qr, setQr] = useState('');
  const [now, setNow] = useState(Date.now());

  const fresh = () => request<{ code: string; expiresAt: number }>({ type: 'pairCode' }).then(setCode, (e) => toast(e.message, 'error'));
  useEffect(() => {
    fresh();
  }, []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (code && code.expiresAt < now) fresh();
  }, [now]);
  useEffect(() => {
    if (!code || !base) return setQr('');
    QRCode.toString(`${base}/?pair=${code.code}`, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0b0c10', light: '#ffffff' } }).then(setQr);
  }, [code?.code, base]);

  const left = code ? Math.max(0, Math.round((code.expiresAt - now) / 1000)) : 0;
  return (
    <div className="pair-panel">
      {qr ? <div className="qr" dangerouslySetInnerHTML={{ __html: qr }} /> : <div className="qr placeholder"><Icon name="phone" size={28} /></div>}
      <div className="pair-info">
        <div className="field-label">{qr ? 'Scan with your phone camera, or type this code in the app' : 'Type this code on the other device'}</div>
        <div className="pair-code">{code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : '··· ···'}</div>
        <div className="faint">
          Expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
          <button className="link-btn" onClick={fresh}>
            New code
          </button>
        </div>
        {base && <div className="mono faint small">{base}</div>}
      </div>
    </div>
  );
}

function Notifications() {
  const support = pushSupport();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pushEnabled().then(setOn);
  }, []);
  const msg =
    support === 'insecure'
      ? 'Needs HTTPS. Open Forkspace through your Tailscale address, or on this Mac via localhost.'
      : support === 'ios-install'
        ? 'On iPhone, add Forkspace to your Home Screen first, then turn this on from the installed app.'
        : support === 'unsupported'
          ? 'This browser does not support notifications.'
          : 'Get a notification when an agent needs you or finishes, while Forkspace is closed.';
  return (
    <div className="setting-row">
      <div className="setting-text">
        <b>Notifications on this device</b>
        <span>{msg}</span>
      </div>
      <Switch
        on={on}
        disabled={support !== 'ok' || busy}
        onChange={async (v) => {
          setBusy(true);
          try {
            v ? await enablePush() : await disablePush();
            setOn(v);
            if (v) toast('Notifications on');
          } catch (e: any) {
            toast(e.message, 'error');
          }
          setBusy(false);
        }}
      />
    </div>
  );
}

function Install() {
  const { canPrompt, prompt } = useInstall();
  if (isStandalone())
    return (
      <div className="setting-row">
        <div className="setting-text">
          <b>Installed</b>
          <span>You are using the Forkspace app.</span>
        </div>
        <Icon name="check" size={18} className="accent-text" />
      </div>
    );
  return (
    <div className="setting-row">
      <div className="setting-text">
        <b>Install the app</b>
        <span>
          {canPrompt
            ? 'Its own window and Dock icon, no browser tabs.'
            : isIOS()
              ? 'In Safari, tap Share, then Add to Home Screen.'
              : 'Chrome or Edge: Install icon in the address bar. Safari on Mac: File, then Add to Dock.'}
        </span>
      </div>
      {canPrompt && (
        <button className="btn primary sm" onClick={prompt}>
          <Icon name="download" size={14} /> Install
        </button>
      )}
    </div>
  );
}

interface ServiceStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  reason?: string;
}

function Appearance() {
  const t = useTheme();
  return (
    <section className="card-section">
      <h3>
        <Icon name="spark" size={16} /> Appearance
      </h3>
      <div className="setting-row">
        <div className="setting-text">
          <b>Theme</b>
          <span>System follows your Mac or phone.</span>
        </div>
        <Segmented<Theme>
          value={t}
          onChange={setTheme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </div>
    </section>
  );
}

function AlwaysOn() {
  const [st, setSt] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => request<ServiceStatus>({ type: 'serviceStatus' }).then(setSt, () => {});
  useEffect(() => {
    load();
  }, []);
  const on = !!st?.installed;
  return (
    <section className="card-section">
      <h3>
        <Icon name="refresh" size={16} /> Always on
      </h3>
      <div className="setting-row">
        <div className="setting-text">
          <b>Keep running in the background</b>
          <span>
            {st && !st.supported
              ? st.reason
              : 'Starts when you log in and restarts itself if it ever stops. No terminal needed, and your phone can always reach it.'}
          </span>
        </div>
        <Switch
          on={on}
          disabled={!st?.supported || busy}
          onChange={async (v) => {
            setBusy(true);
            try {
              if (v) {
                await request({ type: 'serviceEnable' });
                toast('Forkspace now runs in the background. You can close the terminal.');
              } else {
                const r = await request<{ stopping?: boolean }>({ type: 'serviceDisable' });
                toast(r?.stopping ? 'Turned off. Forkspace will stop now; start it with npm start.' : 'Turned off.');
              }
            } catch (e: any) {
              // Enabling hands over to the background copy, so this connection closing is expected.
              if (!/Disconnected/.test(e.message)) toast(e.message, 'error');
            }
            setTimeout(() => {
              load();
              setBusy(false);
            }, 2500);
          }}
        />
      </div>
      {st && !st.supported && <StartCommand compact />}
    </section>
  );
}

export function Settings() {
  const local = isLocalPage();
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  useEffect(() => {
    request<RemoteInfo>({ type: 'remoteInfo' }).then(setInfo, () => {});
  }, []);
  const base = local ? (info?.tailscale.serving ? info.tailscale.url : info?.publicUrl) : location.origin;

  return (
    <div className="settings">
      <section className="card-section">
        <h3>
          <Icon name="phone" size={16} /> Use Forkspace on your phone
        </h3>
        <p className="faint">Agents keep running on this Mac. Your phone is a remote control, so the Mac must be awake with Forkspace running.</p>
        {local && <RemoteAccess info={info} setInfo={setInfo} />}
      </section>

      <section className="card-section">
        <h3>
          <Icon name="lock" size={16} /> Pair a device
        </h3>
        {local && !base ? (
          <p className="faint">Finish the steps above first, then a QR code appears here.</p>
        ) : (
          <PairPanel base={base} />
        )}
      </section>

      <section className="card-section">
        <h3>
          <Icon name="bell" size={16} /> This device
        </h3>
        <Notifications />
        <Install />
      </section>

      <Appearance />

      <AlwaysOn />

      <UpdateSection />

      <MoveSection />

      <section className="card-section">
        <h3>
          <Icon name="chat" size={16} /> Help and feedback
        </h3>
        <p className="faint">Opens GitHub with your version and device filled in. You review it and send it from your own account.</p>
        <div className="feedback-links">
          <a className="btn sm" href={bugReportUrl()} target="_blank" rel="noreferrer">
            <Icon name="external" size={13} /> Report a bug
          </a>
          <a className="btn sm" href={ideaUrl()} target="_blank" rel="noreferrer">
            <Icon name="spark" size={13} /> Suggest an idea
          </a>
          <a className="btn sm" href={questionUrl()} target="_blank" rel="noreferrer">
            <Icon name="chat" size={13} /> Ask a question
          </a>
        </div>
      </section>

      <section className="card-section">
        <h3>
          <Icon name="shield" size={16} /> Security
        </h3>
        <div className="setting-row">
          <div className="setting-text">
            <b>Sign out all other devices</b>
            <span>Makes a new access key. Every paired phone or browser has to pair again.</span>
          </div>
          <button
            className="btn danger sm"
            onClick={async () => {
              if (!confirm('Sign out every other device?')) return;
              try {
                const { token } = await request<{ token: string }>({ type: 'rotateToken' });
                setToken(token);
                toast('Other devices signed out');
              } catch (e: any) {
                toast(e.message, 'error');
              }
            }}
          >
            Sign out others
          </button>
        </div>
      </section>
    </div>
  );
}
