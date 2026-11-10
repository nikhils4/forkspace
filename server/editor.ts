import { spawn } from 'node:child_process';

// Open a folder in the user's editor without asking them to configure anything:
// their FORKSPACE_EDITOR, then VS Code, then Cursor, then the file manager.

function tryCommand(cmd: string, args: string[], waitForExit: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    // Windows: .cmd shims need a shell, so quote every argument for cmd.exe.
    const win = process.platform === 'win32';
    const q = (a: string) => `"${a.replace(/"/g, '""')}"`;
    const child = win
      ? spawn(q(cmd), args.map(q), { detached: !waitForExit, stdio: 'ignore', shell: true, windowsVerbatimArguments: true })
      : spawn(cmd, args, { detached: !waitForExit, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    if (waitForExit) child.on('exit', (code) => resolve(code === 0));
    else
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
  });
}

export async function openFolder(dir: string): Promise<string> {
  const custom = process.env.FORKSPACE_EDITOR;
  if (custom && (await tryCommand(custom, [dir], false))) return custom;
  if (process.platform === 'darwin') {
    // `open -a` works no matter how Forkspace was started (no PATH needed).
    for (const app of ['Visual Studio Code', 'Cursor', 'Zed', 'Windsurf']) if (await tryCommand('open', ['-a', app, dir], true)) return app;
    if (await tryCommand('open', [dir], true)) return 'Finder';
  }
  for (const cli of ['code', 'cursor', 'zed']) if (await tryCommand(cli, [dir], false)) return cli;
  if (process.platform === 'win32' && (await tryCommand('explorer', [dir], false))) return 'Explorer';
  if (process.platform === 'linux' && (await tryCommand('xdg-open', [dir], false))) return 'file manager';
  throw new Error('Could not find an editor to open this folder. Set FORKSPACE_EDITOR to your editor command.');
}
