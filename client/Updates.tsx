import { useEffect, useState } from 'react';
import type { UpdateInfo } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { request, toast, useStore } from './store.ts';

let shared: UpdateInfo | null = null;
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

  const apply = async () => {
    setRunning(true);
    try {
      const r = await request<{ restarted: boolean }>({ type: 'applyUpdate' });
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
                  : info.behind
                    ? `${info.behind} update${info.behind === 1 ? '' : 's'} available.`
                    : 'You have the latest version.'}
          </span>
        </div>
        {info?.channel === 'git' && !info.behind && (
          <button className="btn sm" onClick={check} disabled={checking}>
            {checking ? <span className="spinner" /> : <Icon name="refresh" size={13} />} Check
          </button>
        )}
      </div>

      {info && info.behind > 0 && (
        <>
          <ul className="changes">
            {info.changes.slice(0, 6).map((c) => (
              <li key={c.hash}>
                <span className="ellipsis">{c.subject}</span>
                <span className="faint small">{c.when}</span>
              </li>
            ))}
          </ul>
          {info.dirty && <div className="error-box">You have local changes in the Forkspace folder. Commit or stash them to update.</div>}
          <button className="btn primary update-btn" onClick={apply} disabled={running || info.dirty}>
            {running ? (
              <>
                <span className="spinner light" /> {update?.stage ?? 'Updating…'}
              </>
            ) : (
              'Update and restart'
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
  if (!info?.behind || info.channel !== 'git') return null;
  return (
    <button className="side-link update-pill" onClick={onOpen}>
      <span className="update-dot" /> Update available
    </button>
  );
}
