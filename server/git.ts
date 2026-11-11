import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HOME } from './store.ts';

const run = promisify(execFile);

// Commits are yours: git uses your own user.name and user.email, exactly like a commit you make
// by hand (hosts like Vercel reject commits from unknown authors). Only when git has no identity
// at all does a checkpoint fall back to a Forkspace one, so it never fails.
const GIT_ENV = { ...process.env };
const FALLBACK_IDENTITY = {
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
  // Never delete anything outside Forkspace's own worktrees folder, whatever a branch record says.
  const rel = path.relative(path.join(HOME, 'worktrees'), path.resolve(dir));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  try {
    await git(root, 'worktree', 'remove', '--force', dir);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    await git(root, 'worktree', 'prune').catch(() => {});
  }
  if (branch) await git(root, 'branch', '-D', branch).catch(() => {});
}

async function hasIdentity(dir: string) {
  const get = (k: string) => git(dir, 'config', '--get', k).catch(() => '');
  return !!((await get('user.name')) && (await get('user.email')));
}

/** Stage everything in the worktree and describe it, before committing. */
export async function stageAll(dir: string) {
  await git(dir, 'add', '-A');
  const stat = await git(dir, 'diff', '--cached', '--stat').catch(() => '');
  const patch = await git(dir, 'diff', '--cached', '--no-color', '-U2').catch(() => '');
  return { stat, patch };
}

/** Commit what's staged, as you. Returns the commit hash. */
export async function checkpoint(dir: string, subject: string, body?: string): Promise<string> {
  await git(dir, 'add', '-A');
  const args = ['commit', '-q', '--no-verify', '--allow-empty', '-m', subject, ...(body ? ['-m', body] : [])];
  if (await hasIdentity(dir)) await git(dir, ...args);
  else await run('git', args, { cwd: dir, env: { ...GIT_ENV, ...FALLBACK_IDENTITY } });
  return git(dir, 'rev-parse', 'HEAD');
}

/** Subjects of recent commits, so new ones can match the repo's style. */
export async function recentSubjects(dir: string, n = 12) {
  const out = await git(dir, 'log', `-${n * 2}`, '--format=%s').catch(() => '');
  return out
    .split('\n')
    .filter((s) => s && !/^forkspace: /.test(s))
    .slice(0, n);
}

/**
 * Where a step's own changes really begin. `startHead` is the commit the folder was on when the
 * step started; `head` is the commit its changes sit on now. If those differ, something moved the
 * folder during the step (the agent ran `git checkout origin/main`, a pull, a rebase): comparing
 * with the old start would count everyone else's work on main as this step's. So start from the
 * first commit the step made itself (one no remote has), or, if it made none, from where it
 * moved to. Your own pushed copy of this branch doesn't count as "someone else's": pushing a
 * step for a PR mustn't make its work disappear from the list.
 */
export async function stepBase(dir: string, base: string, startHead: string, head: string): Promise<string> {
  if (!head || head === startHead) return base;
  try {
    const branch = await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => 'HEAD');
    // Patterns match remote names without "refs/remotes/", e.g. "origin/my-branch".
    const mine = [`--exclude=*/${branch}`, '--exclude=*/HEAD'];
    const own = (await git(dir, 'rev-list', '--reverse', '--topo-order', head, '--not', startHead, ...mine, '--remotes')).split('\n').filter(Boolean);
    if (!own.length) return head;
    return await git(dir, 'rev-parse', `${own[0]}^`).catch(() => head);
  } catch {
    return base;
  }
}

/** The commit the folder was on when a step started: the start itself, or a snapshot's parent. */
export async function startHeadOf(dir: string, base: string, snapshotMode: boolean) {
  return snapshotMode ? git(dir, 'rev-parse', `${base}^`).catch(() => base) : base;
}

export async function diffStat(dir: string, from: string, to: string) {
  const out = await git(dir, 'diff', '--shortstat', from, to);
  const num = (re: RegExp) => Number(out.match(re)?.[1] ?? 0);
  return { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) };
}

export async function diff(dir: string, from: string, to: string) {
  return git(dir, 'diff', '--no-color', from, to);
}

/**
 * Changes in a folder since `base`, as it is right now: edited, deleted and brand-new files
 * (new files git doesn't know yet included). Nothing is staged or committed.
 */
export async function liveDiff(dir: string, base: string): Promise<string> {
  const tracked = await git(dir, 'diff', '--no-color', base).catch(() => '');
  const untracked = (await git(dir, '-c', 'core.quotepath=off', 'ls-files', '-o', '--exclude-standard').catch(() => '')).split('\n').filter(Boolean).slice(0, 60);
  const parts = [tracked];
  for (const f of untracked) {
    try {
      if (fs.statSync(path.join(dir, f)).size > 400_000) {
        parts.push(`diff --git a/${f} b/${f}\nnew file mode 100644\n--- /dev/null\n+++ b/${f}\n@@ new file, too big to show @@`);
        continue;
      }
      await run('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', f], { cwd: dir, env: GIT_ENV, maxBuffer: 8 * 1024 * 1024 });
    } catch (e: any) {
      // git diff --no-index exits 1 when the files differ, which is always here.
      if (e?.stdout) parts.push(String(e.stdout).trim());
    }
  }
  return parts.filter(Boolean).join('\n');
}

/** Counts for liveDiff: files, lines added and removed. */
export async function liveStat(dir: string, base: string) {
  const out = await git(dir, 'diff', '--shortstat', base).catch(() => '');
  const num = (re: RegExp) => Number(out.match(re)?.[1] ?? 0);
  const stat = { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) };
  const untracked = (await git(dir, '-c', 'core.quotepath=off', 'ls-files', '-o', '--exclude-standard').catch(() => '')).split('\n').filter(Boolean);
  for (const f of untracked.slice(0, 200)) {
    stat.files++;
    try {
      const st = fs.statSync(path.join(dir, f));
      if (st.size < 400_000) stat.insertions += fs.readFileSync(path.join(dir, f), 'utf8').split('\n').length;
    } catch {}
  }
  return stat;
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

/**
 * A commit of the folder exactly as it is right now (uncommitted and new files included,
 * ignored files skipped) without touching the user's index, branch or working tree.
 */
export async function snapshot(root: string): Promise<string> {
  const os = await import('node:os');
  const tmpIndex = path.join(os.tmpdir(), `forkspace-index-${process.pid}-${Date.now()}`);
  const env = { ...GIT_ENV, GIT_INDEX_FILE: tmpIndex, ...((await hasIdentity(root)) ? {} : FALLBACK_IDENTITY) };
  const g = async (...args: string[]) => (await run('git', args, { cwd: root, env, maxBuffer: 64 * 1024 * 1024 })).stdout.trim();
  try {
    await g('read-tree', 'HEAD');
    await g('add', '-A');
    const tree = await g('write-tree');
    return await g('commit-tree', tree, '-p', 'HEAD', '-m', 'forkspace: snapshot of the folder');
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}
