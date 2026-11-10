import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Release, UpdateInfo } from '../shared/types.ts';
import { HOME } from './store.ts';

// Versioned updates for git installs. A release is an annotated tag vX.Y.Z whose message holds
// its notes (see scripts/release.mjs). Updating moves the folder to the newest release
// (fast-forward only), reinstalls if the dependencies changed, rebuilds and restarts in place.

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Package root: the folder with Forkspace's package.json (server/ in dev, build/server/ when built). */
const ROOT = (() => {
  let dir = HERE;
  for (let i = 0; i < 4; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'forkspace') return dir;
      } catch {}
    }
    dir = path.dirname(dir);
  }
  return path.resolve(HERE, '..');
})();

/** Running the TypeScript source directly (npm run dev): the dev watchers reload by themselves. */
const DEV = !HERE.split(path.sep).includes('build');

const readVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
};

const git = async (...args: string[]) => (await run('git', args, { cwd: ROOT, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();

/** What this process started with. The folder can move on without us (git pull by hand). */
const RUNNING_VERSION = readVersion();
const RUNNING_COMMIT = await git('rev-parse', 'HEAD').catch(() => '');

/** -1, 0 or 1. Plain X.Y.Z; anything after a dash sorts before the release. */
export function compareVersions(a: string, b: string) {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-');
    return { n: core.split('.').map((x) => Number(x) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0) ? 1 : -1;
  if (x.pre === y.pre) return 0;
  return x.pre ? -1 : 1;
}

let cached: UpdateInfo | null = null;
let busy = false;

export async function currentBuild() {
  return RUNNING_COMMIT.slice(0, 7) || RUNNING_VERSION;
}

/** Release tags from origin, newest first, with their notes. */
async function releases(): Promise<(Release & { tag: string })[]> {
  const out = await git('for-each-ref', 'refs/tags/v*', '--sort=-v:refname', '--format=%(refname:short)%00%(creatordate:relative)%00%(contents)%01');
  return out
    .split('\x01')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [tag, when, body = ''] = r.split('\0');
      const notes = body
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^[-*] /.test(l))
        .map((l) => l.slice(2).trim());
      return { tag, version: tag.slice(1), when, notes };
    })
    .filter((r) => /^\d+\.\d+\.\d+/.test(r.version));
}

const LOCK = 'package-lock.json';

/** Tracked files with local edits, staged or not. */
const edited = async () => (await git('diff', '--name-only', 'HEAD')).split('\n').filter(Boolean);

const isAncestor = (a: string, b: string) =>
  git('merge-base', '--is-ancestor', a, b).then(
    () => true,
    () => false,
  );

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  if (cached && !force && Date.now() - (cached.checkedAt ?? 0) < 10 * 60_000) return cached;
  const info: UpdateInfo = { channel: 'none', version: RUNNING_VERSION, releases: [], restartPending: false, conflicts: [], dev: DEV, checkedAt: Date.now() };
  try {
    if (!fs.existsSync(path.join(ROOT, '.git'))) throw new Error('not a checkout');
    info.channel = 'git';
    info.commit = RUNNING_COMMIT.slice(0, 7);
    const head = await git('rev-parse', 'HEAD');
    // Newer code already in the folder than what this process runs.
    info.restartPending = !DEV && !!RUNNING_COMMIT && head !== RUNNING_COMMIT && (await isAncestor(RUNNING_COMMIT, head));

    await git('fetch', '--quiet', '--tags', '--force', 'origin');
    const all = await releases();
    info.releases = all.filter((r) => compareVersions(r.version, RUNNING_VERSION) > 0).map(({ tag: _t, ...r }) => r);
    const target = all[0];
    if (target && compareVersions(target.version, RUNNING_VERSION) > 0 && !(await isAncestor(target.tag, 'HEAD'))) {
      // Local edits only block the files this update changes.
      const dirty = await edited();
      if (dirty.length) {
        const touched = new Set((await git('diff', '--name-only', 'HEAD', target.tag)).split('\n'));
        // package-lock.json changes come from npm install; the update reinstalls anyway.
        info.conflicts = dirty.filter((f) => touched.has(f) && f !== LOCK);
      }
      if (!(await isAncestor('HEAD', target.tag))) info.error = 'Your Forkspace folder has commits of its own. Update it by hand with git.';
    }
  } catch (err: any) {
    if (info.channel === 'git') info.error = `Could not check for updates: ${String(err?.stderr || err?.message || err).trim().split('\n')[0]}`;
  }
  cached = info;
  return info;
}

type Progress = (stage: string, extra?: { done?: boolean; error?: string }) => void;

function sh(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} failed: ${err.trim().split('\n').slice(-3).join(' ')}`))));
  });
}

/** Move to the newest release (or just finish a pending one), install, build, restart. */
export async function applyUpdate(setAside: boolean, progress: Progress, beforeRestart: () => void) {
  if (busy) throw new Error('An update is already running.');
  const info = await checkForUpdate(true);
  if (info.channel !== 'git') throw new Error('This copy was not installed from git. Update it with your package manager.');
  if (info.error) throw new Error(info.error);
  if (info.conflicts.length && !setAside) throw new Error(`You changed ${info.conflicts.join(', ')}, which this update also changes.`);
  const target = (await releases())[0];
  const needsPull = !!target && compareVersions(target.version, RUNNING_VERSION) > 0 && !(await isAncestor(target.tag, 'HEAD'));
  if (!needsPull && !info.restartPending) throw new Error('You already have the latest version.');
  busy = true;
  try {
    const from = RUNNING_COMMIT || (await git('rev-parse', 'HEAD'));
    if (needsPull) {
      const dirty = await edited();
      if (dirty.includes(LOCK)) await git('checkout', '--', LOCK);
      if (info.conflicts.length) {
        progress('Setting your changes aside…');
        await git('stash', 'push', '-m', `Set aside by the Forkspace ${target.version} update`, '--', ...info.conflicts);
      }
      progress(`Downloading ${target.version}…`);
      await git('merge', '--ff-only', '--quiet', target.tag);
    }
    const changed = await git('diff', '--name-only', from, 'HEAD');
    if (/(^|\n)package(-lock)?\.json$/m.test(changed)) {
      progress('Installing new dependencies…');
      await sh('npm', ['install', '--no-audit', '--no-fund']);
    }
    cached = null;
    if (DEV) {
      busy = false;
      progress('Updated. Your dev server reloads on its own.', { done: true });
      return { restarted: false };
    }
    progress('Building…');
    await sh('npm', ['run', 'build']);
    progress('Restarting…');
    restart(beforeRestart);
    return { restarted: true };
  } catch (err: any) {
    busy = false;
    throw err;
  }
}

function restart(beforeRestart: () => void) {
  // Running as the background service: launchd starts us again by itself (KeepAlive).
  // Starting our own copy too would leave two servers fighting over the port.
  if (process.env.XPC_SERVICE_NAME?.includes('dev.forkspace')) {
    console.log('\n  Forkspace updated. The background service restarts it.\n');
    beforeRestart();
    setTimeout(() => process.exit(0), 400);
    return;
  }
  const log = fs.openSync(path.join(HOME, 'server.log'), 'a');
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  console.log(`\n  Forkspace updated. Restarted in the background (pid ${child.pid}). Logs: ${path.join(HOME, 'server.log')}\n`);
  beforeRestart();
  setTimeout(() => process.exit(0), 400);
}
