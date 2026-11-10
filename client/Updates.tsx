import { useEffect, useState } from 'react';
import type { UpdateInfo } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { request, toast, useStore } from './store.ts';

let shared: UpdateInfo | null = null;
/** Latest update info, for code outside React (bug reports). */
export const currentUpdate = () => shared;
const subs = new Set<(i: UpdateInfo) => void>();
const publish = (i: UpdateInfo) => {
  shared = i;
  subs.forEach((s) => s(i));
};

/** Update status, checked on load and every 30 minutes (the server caches GitHub checks). */
export function useUpdate() {
  const { connected } = useStore();
  const [info, setInfo] = useState<UpdateInfo | null>(shared);
  useEffect(() => {
    subs.add(setInfo);
    return () => void subs.delete(setInfo);
  }, []);
  useEffect(() => {
    if (!connected) return;
    const check = () => request<UpdateInfo>({ type: 'updateInfo' }).then(publish, () => {});
    check();
    const id = setInterval(check, 30 * 60_000);
    return () => clearInterval(id);
  }, [connected]);
  return info;
}

export function UpdateSection() {
  const info = useUpdate();
  const { update } = useStore();
  const [checking, setChecking] = useState(false);
  const [running, setRunning] = useState(false);
  // Opening Settings always asks GitHub fresh.
  useEffect(() => {
    request<UpdateInfo>({ type: 'updateInfo', force: true }).then(publish, () => {});
  }, []);

  const check = async () => {
    setChecking(true);
    try {
      publish(await request<UpdateInfo>({ type: 'updateInfo', force: true }));
    } catch (e: any) {
      toast(e.message, 'error');
    }
    setChecking(false);
  };

  const apply = async (setAside = false) => {
    setRunning(true);
    try {
      const r = await request<{ restarted: boolean }>({ type: 'applyUpdate', setAside });
      if (!r.restarted) {
        setRunning(false);
        check();
      }
      // When it restarts, the page reloads by itself once the new version is up.
    } catch (e: any) {
      toast(e.message, 'error');
      setRunning(false);
    }
  };

  const latest = info?.releases[0];
  const blocked = !!info?.conflicts.length;
  const ready = !!info && info.channel === 'git' && !info.error && (!!latest || info.restartPending);
  const label = latest ? `Update to ${latest.version}` : 'Restart to finish';

  return (
    <section className="card-section">
      <h3>
        <Icon name="download" size={16} /> Forkspace
      </h3>
      <div className="setting-row">
        <div className="setting-text">
          <b>
            Version {info?.version ?? '…'}
            {info?.commit && <span className="faint mono small"> · {info.commit}</span>}
          </b>
          <span>
            {!info
              ? 'Checking for updates…'
              : info.channel !== 'git'
                ? 'Installed without git. Update with your package manager.'
                : info.error
                  ? info.error
                  : latest
                    ? `Version ${latest.version} is available.`
                    : info.restartPending
                      ? 'A newer version is downloaded. Restart to use it.'
                      : 'You have the latest version.'}
          </span>
        </div>
        {info?.channel === 'git' && !ready && (
          <button className="btn sm" onClick={check} disabled={checking}>
            {checking ? <span className="spinner" /> : <Icon name="refresh" size={13} />} Check
          </button>
        )}
      </div>

      {info && info.releases.length > 0 && (
        <div className="releases">
          {info.releases.slice(0, 4).map((r) => (
            <div className="release" key={r.version}>
              <div className="release-head">
                <b>{r.version}</b>
                <span className="faint small">{r.when}</span>
              </div>
              {r.notes.length > 0 && (
                <ul>
                  {r.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}

      {ready && (
        <>
          {blocked && (
            <div className="error-box">
              You edited {info!.conflicts.join(', ')} in the Forkspace folder, and this update changes {info!.conflicts.length === 1 ? 'it' : 'them'} too.
              Set your edits aside to update. They stay safe in <code>git stash</code>.
            </div>
          )}
          <button className="btn primary update-btn" onClick={() => apply(blocked)} disabled={running}>
            {running ? (
              <>
                <span className="spinner light" /> {update?.stage ?? 'Updating…'}
              </>
            ) : blocked ? (
              `Set aside my edits and ${label.toLowerCase()}`
            ) : (
              label
            )}
          </button>
          <span className="faint small">Takes about a minute. Your boards, branches and concepts stay as they are.</span>
        </>
      )}
    </section>
  );
}

/** Sidebar nudge when an update is waiting. */
export function UpdatePill({ onOpen }: { onOpen: () => void }) {
  const info = useUpdate();
  if (!info || info.channel !== 'git' || (!info.releases.length && !info.restartPending)) return null;
  return (
    <button className="side-link update-pill" onClick={onOpen}>
      <span className="update-dot" /> {info.releases.length ? `Update to ${info.releases[0].version}` : 'Restart to update'}
    </button>
  );
}
