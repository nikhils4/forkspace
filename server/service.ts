import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HOME } from './store.ts';

// "Keep running in the background": a macOS login item (launchd agent) that starts
// Forkspace when you log in and restarts it if it ever stops. No terminal needed.

const run = promisify(execFile);
const LABEL = 'dev.forkspace';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILT = HERE.split(path.sep).includes('build');
/** Package root (build/server -> two levels up, server -> one). */
export const INSTALL_DIR = path.resolve(HERE, BUILT ? '../..' : '..');
const ENTRY = path.join(INSTALL_DIR, 'build', 'server', 'index.js');

const uid = () => process.getuid?.() ?? 0;
const target = () => `gui/${uid()}`;

export interface ServiceStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  /** Why it can't be turned on here, if it can't. */
  reason?: string;
  /** How to start Forkspace by hand. */
  startCommand: string;
}

export const startCommand = () => `cd ${JSON.stringify(INSTALL_DIR)} && npm start`;

export async function serviceStatus(): Promise<ServiceStatus> {
  const base = { startCommand: startCommand() };
  if (process.platform !== 'darwin') return { ...base, supported: false, installed: false, running: false, reason: 'Available on macOS for now.' };
  if (!BUILT || !fs.existsSync(ENTRY)) return { ...base, supported: false, installed: false, running: false, reason: 'Run Forkspace with npm start (not dev mode) to turn this on.' };
  const installed = fs.existsSync(PLIST);
  let running = false;
  if (installed) running = await run('launchctl', ['print', `${target()}/${LABEL}`]).then(() => true, () => false);
  return { ...base, supported: true, installed, running };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist(port: number) {
  const env: Record<string, string> = {
    PORT: String(port),
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  };
  for (const k of ['FORKSPACE_HOME', 'HOST', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'FORKSPACE_EDITOR', 'FORKSPACE_MENTOR_MODEL']) if (process.env[k]) env[k] = process.env[k]!;
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join('\n');
  const log = esc(path.join(HOME, 'server.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${esc(process.execPath)}</string>
      <string>${esc(ENTRY)}</string>
    </array>
    <key>WorkingDirectory</key><string>${esc(INSTALL_DIR)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>5</integer>
    <key>StandardOutPath</key><string>${log}</string>
    <key>StandardErrorPath</key><string>${log}</string>
  </dict>
</plist>
`;
}

/**
 * Install and start the login item. The copy you started in a terminal hands over:
 * `handOver` closes it, and the background copy takes the port a moment later.
 */
export async function enableService(port: number, handOver: () => void) {
  const st = await serviceStatus();
  if (!st.supported) throw new Error(st.reason);
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  // Mode 600: the file may hold your API key.
  fs.writeFileSync(PLIST, plist(port), { mode: 0o600 });
  // Already on (this is likely the background copy itself): settings saved, nothing to restart.
  if (st.running) return { handedOver: false };
  await run('launchctl', ['bootout', `${target()}/${LABEL}`]).catch(() => {});
  handOver();
  await run('launchctl', ['bootstrap', target(), PLIST]);
  setTimeout(() => process.exit(0), 300);
  return { handedOver: true };
}

/** Turn it off. If this process is the background copy, Forkspace stops until started again. */
export async function disableService() {
  if (process.platform !== 'darwin') return;
  const wasService = !!process.env.XPC_SERVICE_NAME?.includes(LABEL);
  fs.rmSync(PLIST, { force: true });
  if (wasService) setTimeout(() => run('launchctl', ['bootout', `${target()}/${LABEL}`]).catch(() => {}), 300);
  else await run('launchctl', ['bootout', `${target()}/${LABEL}`]).catch(() => {});
  return { stopping: wasService };
}
