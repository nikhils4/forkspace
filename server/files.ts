import fs from 'node:fs';
import path from 'node:path';
import type { Board, Branch, ChangedFile, FileResult, FilesResult } from '../shared/types.ts';
import * as g from './git.ts';
import { state } from './store.ts';

const MAX_FILES = 20000;
const MAX_BYTES = 1_500_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'target', '.turbo', '.cache']);

/** The commit this branch's whole thread started from, so "changes" means everything the agents did. */
function threadBase(branch: Branch): string | undefined {
  const turns = state.nodes.filter((n) => n.kind === 'turn' && n.branchId === branch.id);
  if (!turns.length) return undefined;
  let cur: any = turns.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
  while (cur?.parentId) cur = state.nodes.find((n) => n.id === cur.parentId);
  return cur?.baseCommit;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(p);
      } else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

export async function listFiles(board: Board, branch: Branch): Promise<FilesResult> {
  const cwd = branch.cwd;
  const repo = !!board.repoRoot;
  let files: string[];
  if (repo) {
    const out = await g.git(cwd, '-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard');
    files = out ? out.split('\n') : [];
  } else files = walk(cwd);
  files = [...new Set(files)].slice(0, MAX_FILES).sort();

  const changed: ChangedFile[] = [];
  if (repo) {
    const base = threadBase(branch) ?? 'HEAD';
    const [num, names, untracked] = await Promise.all([
      g.git(cwd, '-c', 'core.quotepath=off', 'diff', '--relative', '--numstat', base).catch(() => ''),
      g.git(cwd, '-c', 'core.quotepath=off', 'diff', '--relative', '--name-status', base).catch(() => ''),
      g.git(cwd, '-c', 'core.quotepath=off', 'ls-files', '-o', '--exclude-standard').catch(() => ''),
    ]);
    const stats = new Map<string, { add: number; del: number }>();
    for (const line of num.split('\n').filter(Boolean)) {
      const [a, d, ...rest] = line.split('\t');
      stats.set(rest.join('\t'), { add: Number(a) || 0, del: Number(d) || 0 });
    }
    for (const line of names.split('\n').filter(Boolean)) {
      const [code, ...rest] = line.split('\t');
      const p = rest[rest.length - 1];
      const status = (code[0] === 'R' ? 'R' : code[0]) as ChangedFile['status'];
      changed.push({ path: p, status, ...(stats.get(p) ?? { add: 0, del: 0 }) });
    }
    for (const p of untracked.split('\n').filter(Boolean)) {
      if (changed.some((c) => c.path === p)) continue;
      let add = 0;
      try {
        add = fs.readFileSync(path.join(cwd, p), 'utf8').split('\n').length;
      } catch {}
      changed.push({ path: p, status: 'A', add, del: 0 });
    }
  }
  return { root: cwd, files, changed, truncated: files.length >= MAX_FILES, git: repo };
}

/** Resolve a path inside the branch folder; refuse anything that escapes it (../, symlinks). */
function safePath(cwd: string, rel: string): string {
  const root = fs.realpathSync(cwd);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path is outside the project');
  if (fs.existsSync(abs)) {
    const real = fs.realpathSync(abs);
    if (real !== root && !real.startsWith(root + path.sep)) throw new Error('Path is outside the project');
  }
  return abs;
}

function decode(buf: Buffer): { text: string; binary: boolean } {
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) return { text: '', binary: true };
  return { text: buf.toString('utf8'), binary: false };
}

export async function readFile(board: Board, branch: Branch, rel: string): Promise<FileResult> {
  const abs = safePath(branch.cwd, rel);
  const res: FileResult = { path: rel, text: '', exists: fs.existsSync(abs) };

  if (res.exists) {
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error('Not a file');
    if (st.size > MAX_BYTES) return { ...res, tooLarge: true, size: st.size };
    const d = decode(fs.readFileSync(abs));
    if (d.binary) return { ...res, binary: true, size: st.size };
    res.text = d.text;
  }

  if (board.repoRoot) {
    const base = threadBase(branch) ?? 'HEAD';
    const top = branch.worktree ?? board.repoRoot;
    const repoRel = path.relative(top, abs).split(path.sep).join('/');
    const buf = await g.showFile(top, base, repoRel, 8 * MAX_BYTES);
    if (!buf) res.base = ''; // file did not exist when the thread started
    else {
      const d = decode(buf);
      if (!d.binary && buf.length <= MAX_BYTES) res.base = d.text;
    }
  }
  return res;
}
