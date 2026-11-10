import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  // Checkpoints must never fail on a missing identity or a hook.
  GIT_AUTHOR_NAME: 'Forkspace',
  GIT_AUTHOR_EMAIL: 'forkspace@localhost',
  GIT_COMMITTER_NAME: 'Forkspace',
  GIT_COMMITTER_EMAIL: 'forkspace@localhost',
};

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: GIT_ENV, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return await git(dir, 'rev-parse', '--show-toplevel');
  } catch {
    return null;
  }
}

export async function hasCommits(root: string): Promise<boolean> {
  try {
    await git(root, 'rev-parse', '--verify', 'HEAD');
    return true;
  } catch {
    return false;
  }
}

/** New worktree on a new branch starting at `from`. */
export async function addWorktree(root: string, dir: string, branch: string, from: string) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(root, 'worktree', 'add', '-q', '-b', branch, dir, from);
}

export async function removeWorktree(root: string, dir: string, branch?: string) {
  try {
    await git(root, 'worktree', 'remove', '--force', dir);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    await git(root, 'worktree', 'prune').catch(() => {});
  }
  if (branch) await git(root, 'branch', '-D', branch).catch(() => {});
}

/** Commit everything in the worktree so this point can be forked later. Returns the commit hash. */
export async function checkpoint(dir: string, message: string): Promise<string> {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '--no-verify', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

export async function diffStat(dir: string, from: string, to: string) {
  const out = await git(dir, 'diff', '--shortstat', from, to);
  const num = (re: RegExp) => Number(out.match(re)?.[1] ?? 0);
  return { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) };
}

export async function diff(dir: string, from: string, to: string) {
  return git(dir, 'diff', '--no-color', from, to);
}

/** File contents at a commit, as raw bytes (null when the file did not exist there). */
export async function showFile(cwd: string, ref: string, repoPath: string, maxBuffer: number): Promise<Buffer | null> {
  try {
    const { stdout } = await run('git', ['show', `${ref}:${repoPath}`], { cwd, env: GIT_ENV, encoding: 'buffer', maxBuffer });
    return stdout;
  } catch {
    return null;
  }
}
