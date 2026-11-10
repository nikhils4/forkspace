import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CANDIDATES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
];

let bin: string | null | undefined;

async function findBin(): Promise<string | null> {
  if (bin !== undefined) return bin;
  for (const c of CANDIDATES) {
    if (c.includes('/') && !fs.existsSync(c)) continue;
    try {
      await run(c, ['version'], { timeout: 4000 });
      return (bin = c);
    } catch {}
  }
  return (bin = null);
}

async function ts(...args: string[]) {
  const b = await findBin();
  if (!b) throw new Error('Tailscale is not installed');
  const { stdout } = await run(b, args, { timeout: 15000 });
  return stdout;
}

export interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  url?: string;
  serving: boolean;
}

export async function tailscaleInfo(port: number): Promise<TailscaleInfo> {
  bin = undefined; // re-detect: the user may have just installed it
  if (!(await findBin())) return { installed: false, running: false, serving: false };
  try {
    const status = JSON.parse(await ts('status', '--json'));
    const running = status.BackendState === 'Running';
    const dns = String(status.Self?.DNSName ?? '').replace(/\.$/, '');
    let serving = false;
    try {
      const serve = await ts('serve', 'status', '--json');
      serving = serve.includes(`127.0.0.1:${port}`) || serve.includes(`localhost:${port}`);
    } catch {}
    return { installed: true, running, url: dns ? `https://${dns}` : undefined, serving };
  } catch {
    return { installed: true, running: false, serving: false };
  }
}

/** Serve this app over HTTPS to the user's own tailnet only (not the public internet). */
export async function enableTailscaleServe(port: number) {
  await ts('serve', '--bg', String(port));
}
