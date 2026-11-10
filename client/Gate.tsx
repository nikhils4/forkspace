import { useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { connect, pair } from './store.ts';

/** Shown on a device that has not been paired yet. */
export function PairScreen() {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const submit = async (c = code) => {
    if (c.length !== 6 || busy) return;
    setBusy(true);
    setErr('');
    try {
      await pair(c);
    } catch (e: any) {
      setErr(e.message);
      setCode('');
      ref.current?.focus();
    }
    setBusy(false);
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="app-mark big">
          <Icon name="branch" size={28} strokeWidth={2} />
        </div>
        <h1>Pair with your Mac</h1>
        <p>
          On your Mac, open Forkspace, go to <b>Devices</b>, and type the 6-digit code shown there.
        </p>
        <div className="code-input" onClick={() => ref.current?.focus()}>
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className={`code-cell ${i === code.length ? 'active' : ''} ${code[i] ? 'filled' : ''}`}>
              {code[i] ?? ''}
            </span>
          ))}
          <input
            ref={ref}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            aria-label="Pairing code"
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(v);
              setErr('');
              if (v.length === 6) submit(v);
            }}
          />
        </div>
        {err && <div className="error-box">{err}</div>}
        <button className="btn primary block" disabled={code.length !== 6 || busy} onClick={() => submit()}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </div>
    </div>
  );
}

export function UnreachableScreen() {
  return (
    <div className="gate">
      <div className="gate-card">
        <div className="app-mark big muted">
          <Icon name="wifiOff" size={26} />
        </div>
        <h1>Can't reach your Mac</h1>
        <p>Make sure your Mac is awake, Forkspace is running, and (on your phone) Tailscale is connected.</p>
        <button className="btn primary block" onClick={() => connect()}>
          <Icon name="refresh" size={15} /> Try again
        </button>
      </div>
    </div>
  );
}

export function Splash() {
  return (
    <div className="gate">
      <div className="app-mark big pulse">
        <Icon name="branch" size={28} strokeWidth={2} />
      </div>
    </div>
  );
}
