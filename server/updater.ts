import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { UpdateInfo } from '../shared/types.ts';
import { HOME } from './store.ts';

// One-click updates for git installs: fetch, pull (fast-forward only), reinstall if the
// dependencies changed, rebuild, and restart in place. The page reconnects on its own.

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

const version = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
  } catch {
    return '0.0.0';
  }
};

const git = async (...args: string[]) => (await run('git', args, { cwd: ROOT, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();

let cached: UpdateInfo | null = null;
let busy = false;

export async function currentBuild() {
  try {
    return await git('rev-parse', '--short', 'HEAD');
  } catch {
    return version();
  }
}

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  if (cached && !force && Date.now() - (cached.checkedAt ?? 0) < 10 * 60_000) return cached;
  const info: UpdateInfo = { channel: 'none', version: version(), behind: 0, changes: [], dirty: false, dev: DEV, checkedAt: Date.now() };
  try {
    await git('rev-parse', '--is-inside-work-tree');
    if (!fs.existsSync(path.join(ROOT, '.git'))) throw new Error('not a checkout');
    info.channel = 'git';
    info.commit = await git('rev-parse', '--short', 'HEAD');
    info.dirty = (await git('status', '--porcelain', '--untracked-files=no')).length > 0;
    await git('fetch', '--quiet', 'origin');
    const upstream = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').catch(async () => `origin/${await git('rev-parse', '--abbrev-ref', 'HEAD')}`);
    info.behind = Number(await git('rev-list', '--count', `HEAD..${upstream}`)) || 0;
    if (info.behind) {
      const log = await git('log', `HEAD..${upstream}`, '-n', '20', '--format=%h%x09%s%x09%cr');
      info.changes = log
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [hash, subject, when] = l.split('\t');
          return { hash, subject, when };
        });
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

/** Pull, install, build, restart. `beforeRestart` flushes state and closes connections. */
export async function applyUpdate(progress: Progress, beforeRestart: () => void) {
  if (busy) throw new Error('An update is already running.');
  const info = await checkForUpdate(true);
  if (info.channel !== 'git') throw new Error('This copy was not installed from git. Update it with your package manager.');
  if (info.dirty) throw new Error('You have local changes in the Forkspace folder. Commit or stash them, then update.');
  if (!info.behind) throw new Error('You already have the latest version.');
  busy = true;
  try {
    const before = await git('rev-parse', 'HEAD');
    progress('Downloading the update…');
    await git('pull', '--ff-only', '--quiet');
    const changed = await git('diff', '--name-only', before, 'HEAD');
    if (/(^|\n)package(-lock)?\.json$/m.test(changed)) {
      progress('Installing new dependencies…');
      await sh('npm', ['install', '--no-audit', '--no-fund']);
    }
    cached = null;
    if (DEV) {
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
