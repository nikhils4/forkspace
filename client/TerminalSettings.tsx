import { useEffect, useState } from 'react';
import { request, toast } from './store.ts';

// Settings → Phone: whether other devices may open a terminal here. Kept apart from the
// terminal itself so xterm only loads when a terminal opens.

export function TerminalSettings() {
  const [s, setS] = useState<{ supported: boolean; remoteAllowed: boolean; here: boolean } | null>(null);
  useEffect(() => {
    request<{ supported: boolean; remoteAllowed: boolean; here: boolean }>({ type: 'termSettings' }).then(setS, () => {});
  }, []);
  if (!s) return null;
  return (
    <div className="setting-row">
      <div className="setting-text">
        <b>Terminal on other devices</b>
        <span>
          {!s.supported
            ? 'The terminal is not available on this computer.'
            : 'Let paired phones and browsers open a terminal on this computer. Off by default: a terminal can run anything.'}
        </span>
      </div>
      <SwitchLite
        on={s.remoteAllowed}
        disabled={!s.here || !s.supported}
        onChange={(v) =>
          request<{ supported: boolean; remoteAllowed: boolean; here: boolean }>({ type: 'termSettings', remoteAllowed: v }).then(
            (r) => {
              setS(r);
              toast(v ? 'Other devices can use the terminal' : 'Terminal is only on this computer now');
            },
            (e: Error) => toast(e.message, 'error'),
          )
        }
      />
    </div>
  );
}

function SwitchLite({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} disabled={disabled} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}
