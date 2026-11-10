import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AwayStatus } from '../shared/types.ts';
import { HOME } from './store.ts';

// Away mode: keep this computer awake while you're gone, so agents keep working and your
// phone can always reach it.
//
//   macOS    caffeinate -i -m -s [-d] -w <our pid>   (dies with us, no cleanup needed)
//   Windows  SetThreadExecutionState from a tiny PowerShell loop that exits when we do
//   Linux    systemd-inhibit … sleep infinity        (killed when we exit)
//
// The setting survives restarts and updates: on start, away mode comes back on by itself.

const run = promisify(execFile);
const FILE = path.join(HOME, 'away.json');

interface Saved {
  on: boolean;
  screen: boolean;
  since?: number;
  /** Last time a phone or other device connected from outside this machine. */
  remoteSeen?: { at: number; device: string };
}

let saved: Saved = { on: false, screen: false };
try {
  saved = { ...saved, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {}
const persist = () => fs.writeFileSync(FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });

let child: ChildProcess | null = null;
let restarts = 0;
let lastError: string | undefined;
const remoteNow = new Set<string>();

function method(): string | null {
  if (process.platform === 'darwin') return 'caffeinate';
  if (process.platform === 'win32') return 'Windows power settings';
  if (process.platform === 'linux') return 'systemd-inhibit';
  return null;
}

function spawnKeeper(): ChildProcess {
  const pid = String(process.pid);
  if (process.platform === 'darwin') return spawn('caffeinate', ['-i', '-m', '-s', ...(saved.screen ? ['-d'] : []), '-w', pid], { stdio: 'ignore' });
  if (process.platform === 'win32') {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED (| ES_DISPLAY_REQUIRED), refreshed while Forkspace runs.
    const flags = saved.screen ? '0x80000003' : '0x80000001';
    const ps =
      `$s = Add-Type -Name P -Namespace F -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';` +
      `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [void]$s::SetThreadExecutionState([uint32]${flags}); Start-Sleep -Seconds 30 }`;
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  }
  const what = saved.screen ? 'idle:sleep' : 'sleep';
  return spawn('systemd-inhibit', [`--what=${what}`, '--who=Forkspace', '--why=Away mode: agents are working', '--mode=block', 'sleep', 'infinity'], { stdio: 'ignore' });
}

function start() {
  if (child || !method()) return;
  try {
    child = spawnKeeper();
  } catch (err: any) {
    lastError = String(err?.message ?? err);
    child = null;
    return;
  }
  lastError = undefined;
  const me = child;
  me.on('error', (err) => {
    lastError = err.message.includes('ENOENT') ? `${method()} is not available on this computer.` : err.message;
  });
  me.on('exit', () => {
    if (child !== me) return;
    child = null;
    // Something killed it while away mode is on: bring it back, but don't spin.
    if (saved.on && restarts++ < 20) setTimeout(start, 2000);
  });
}

function stopKeeper() {
  const c = child;
  child = null;
  c?.kill();
}

for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) process.on(sig, () => child?.kill());

export function setAway(on: boolean, screen?: boolean) {
  const screenChanged = screen !== undefined && screen !== saved.screen;
  if (screen !== undefined) saved.screen = screen;
  if (on && !saved.on) saved.since = Date.now();
  saved.on = on;
  if (!on) saved.since = undefined;
  persist();
  restarts = 0;
  if (!on) stopKeeper();
  else {
    if (screenChanged) stopKeeper();
    start();
  }
}

/** Called for every WebSocket connection, so the setup can tell when your phone is there. */
export function noteDevice(id: string, remote: boolean, userAgent: string, connected: boolean) {
  if (!remote) return;
  if (connected) {
    remoteNow.add(id);
    saved.remoteSeen = { at: Date.now(), device: describe(userAgent) };
    persist();
  } else remoteNow.delete(id);
}

function describe(ua: string) {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'device';
}

async function onBattery(): Promise<boolean | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { stdout } = await run('pmset', ['-g', 'batt'], { timeout: 3000 });
    return /Battery Power/.test(stdout);
  } catch {
    return undefined;
  }
}

export async function awayStatus(): Promise<AwayStatus> {
  return {
    on: saved.on,
    screen: saved.screen,
    since: saved.since,
    supported: !!method(),
    method: method() ?? undefined,
    active: !!child && child.exitCode === null,
    error: lastError,
    onBattery: await onBattery(),
    platform: process.platform,
    remoteConnected: remoteNow.size,
    remoteSeen: saved.remoteSeen,
  };
}

// Back on after a restart or update.
if (saved.on) start();
