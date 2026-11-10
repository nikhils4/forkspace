import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { nanoid } from 'nanoid';
import type { Board, Branch, CanvasNode, ImportPlan, ImportResult } from '../shared/types.ts';
import * as g from './git.ts';
import { projectDir } from './sessions.ts';
import { HOME, save, state } from './store.ts';

// Move a whole workspace to another machine in one file.
//
// The file is gzipped JSON holding:
//   - boards, branches, steps and notes (concepts live on the steps)
//   - the Claude Code transcripts those steps resume, so conversations continue
//   - per board, a git bundle of its forkspace/* branches, so code branches come along
// Not included: the access key, paired devices and push subscriptions (they belong to this machine).

const run = promisify(execFile);
const FORMAT = 'forkspace-export';
const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const MAX_TRANSCRIPT = 200 * 1024 * 1024;

interface FileEntry {
  rel: string;
  data: string; // base64
}
interface Payload {
  format: typeof FORMAT;
  version: 1;
  exportedAt: number;
  home: string;
  boards: Board[];
  branches: Branch[];
  nodes: CanvasNode[];
  transcripts: { sessionId: string; files: FileEntry[] }[];
  bundles: { boardId: string; data: string }[];
}

/** Every file of a session: the .jsonl plus its sidecar folder (subagents, tool output). */
function sessionFiles(sessionId: string): FileEntry[] | null {
  const projects = path.join(CONFIG, 'projects');
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const main = path.join(projects, d, `${sessionId}.jsonl`);
    if (!fs.existsSync(main)) continue;
    const out: FileEntry[] = [{ rel: `${sessionId}.jsonl`, data: fs.readFileSync(main).toString('base64') }];
    const extras = path.join(projects, d, sessionId);
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.isFile()) out.push({ rel: path.relative(path.join(projects, d), abs), data: fs.readFileSync(abs).toString('base64') });
      }
    };
    if (fs.existsSync(extras)) walk(extras);
    return out;
  }
  return null;
}

async function bundleFor(board: Board, branches: Branch[]): Promise<string | null> {
  if (!board.repoRoot) return null;
  const refs: string[] = [];
  for (const b of branches) {
    if (!b.gitBranch) continue;
    const ok = await g.git(board.repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${b.gitBranch}`).then(
      () => true,
      () => false,
    );
    if (ok) refs.push(b.gitBranch);
  }
  if (!refs.length) return null;
  const file = path.join(os.tmpdir(), `forkspace-${nanoid(8)}.bundle`);
  // Leave out history the other machine gets from the remote anyway.
  const remotes = (await g.git(board.repoRoot, 'remote').catch(() => '')).trim();
  try {
    await run('git', ['bundle', 'create', '-q', file, ...refs, ...(remotes ? ['--not', '--remotes'] : [])], { cwd: board.repoRoot, maxBuffer: 16 * 1024 * 1024 });
    return fs.readFileSync(file).toString('base64');
  } catch {
    return null;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export async function exportWorkspace(): Promise<Buffer> {
  const turns = state.nodes.filter((n) => n.kind === 'turn');
  const sessions = new Set(turns.flatMap((n) => (n.kind === 'turn' && n.sessionId ? [n.sessionId] : [])));
  const transcripts: Payload['transcripts'] = [];
  let size = 0;
  for (const id of sessions) {
    const files = sessionFiles(id);
    if (!files) continue;
    size += files.reduce((s, f) => s + f.data.length, 0);
    if (size > MAX_TRANSCRIPT) break;
    transcripts.push({ sessionId: id, files });
  }
  const bundles: Payload['bundles'] = [];
  for (const b of state.boards) {
    const data = await bundleFor(
      b,
      state.branches.filter((x) => x.boardId === b.id),
    );
    if (data) bundles.push({ boardId: b.id, data });
  }
  const payload: Payload = {
    format: FORMAT,
    version: 1,
    exportedAt: Date.now(),
    home: os.homedir(),
    boards: state.boards,
    branches: state.branches,
    nodes: state.nodes,
    transcripts,
    bundles,
  };
  return zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
}

// ---- import: read the file, show a plan, then apply it ----

const pending = new Map<string, { payload: Payload; at: number }>();

function parse(buf: Buffer): Payload {
  let json: any;
  try {
    json = JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  } catch {
    throw new Error('That is not a Forkspace export file.');
  }
  if (json?.format !== FORMAT || !Array.isArray(json.boards)) throw new Error('That is not a Forkspace export file.');
  if (json.version > 1) throw new Error('This file comes from a newer Forkspace. Update this one first.');
  return json as Payload;
}

/** Where a folder probably lives here: same path, with the old home folder swapped for this one. */
function suggest(oldCwd: string, oldHome: string) {
  if (fs.existsSync(oldCwd)) return oldCwd;
  if (oldCwd.startsWith(oldHome + path.sep)) {
    return path.join(os.homedir(), oldCwd.slice(oldHome.length + 1));
  }
  return oldCwd;
}

export function readImport(buf: Buffer): ImportPlan {
  const payload = parse(buf);
  for (const [k, v] of pending) if (Date.now() - v.at > 30 * 60_000) pending.delete(k);
  const id = nanoid(10);
  pending.set(id, { payload, at: Date.now() });
  return {
    id,
    exportedAt: payload.exportedAt,
    boards: payload.boards.map((b) => {
      const where = suggest(b.cwd, payload.home);
      return {
        id: b.id,
        name: b.name,
        oldCwd: b.cwd,
        suggested: where,
        found: fs.existsSync(where),
        already: state.boards.some((x) => x.id === b.id),
        steps: payload.nodes.filter((n) => n.boardId === b.id && n.kind === 'turn').length,
        notes: payload.nodes.filter((n) => n.boardId === b.id && n.kind === 'note').length,
        code: payload.bundles.some((x) => x.boardId === b.id),
      };
    }),
  };
}

export function checkFolder(dir: string) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Bring in the chosen boards. `folders` maps board id to its folder on this machine. */
export async function applyImport(id: string, folders: Record<string, string>): Promise<{ results: ImportResult[]; boards: Board[]; branches: Branch[]; nodes: CanvasNode[] }> {
  const entry = pending.get(id);
  if (!entry) throw new Error('That import expired. Choose the file again.');
  const { payload } = entry;
  const results: ImportResult[] = [];
  const added = { boards: [] as Board[], branches: [] as Branch[], nodes: [] as CanvasNode[] };
  const transcripts = new Map(payload.transcripts.map((t) => [t.sessionId, t.files]));

  for (const old of payload.boards) {
    const folder = folders[old.id];
    if (!folder) continue;
    if (state.boards.some((b) => b.id === old.id)) {
      results.push({ name: old.name, ok: false, note: 'Already on this Mac. Skipped.' });
      continue;
    }
    const cwd = path.resolve(folder.replace(/^~(?=$|\/)/, os.homedir()));
    if (!checkFolder(cwd)) {
      results.push({ name: old.name, ok: false, note: `No folder at ${cwd}.` });
      continue;
    }
    const notes: string[] = [];
    const root = await g.repoRoot(cwd);
    const board: Board = { ...old, cwd, repoRoot: root ?? undefined, relPath: root ? path.relative(root, cwd) : undefined };
    if (board.isolation === 'worktree' && !root) {
      board.isolation = 'none';
      notes.push('Not a git repo here, so branches share the folder.');
    }

    // Code: fetch the forkspace/* branches from the bundle into this repo.
    let fetched = false;
    const bundle = payload.bundles.find((b) => b.boardId === old.id);
    if (bundle && root) {
      const file = path.join(os.tmpdir(), `forkspace-${nanoid(8)}.bundle`);
      fs.writeFileSync(file, Buffer.from(bundle.data, 'base64'));
      try {
        await run('git', ['fetch', '-q', '--no-tags', file, 'refs/heads/forkspace/*:refs/heads/forkspace/*'], { cwd: root });
        fetched = true;
      } catch (err: any) {
        const missing = /prerequisite|lacks these/i.test(String(err?.stderr ?? err?.message));
        notes.push(missing ? 'This copy of the repo is missing commits the branches need. Pull the latest first, then import again for code.' : 'Branch code could not be restored.');
      } finally {
        fs.rmSync(file, { force: true });
      }
    }

    const branches = payload.branches.filter((b) => b.boardId === old.id).map((b) => ({ ...b }));
    let lostCode = false;
    for (const b of branches) {
      const hadCode = !!b.worktree;
      b.worktree = undefined;
      b.cwd = cwd;
      if (!hadCode || b.imported) continue;
      if (fetched && b.gitBranch && root) {
        const dir = path.join(HOME, 'worktrees', board.id, b.id);
        try {
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(path.dirname(dir), { recursive: true });
            await g.git(root, 'worktree', 'add', '-q', dir, b.gitBranch);
          }
          b.worktree = dir;
          b.cwd = board.relPath ? path.join(dir, board.relPath) : dir;
          continue;
        } catch {}
      }
      b.gitBranch = undefined;
      lostCode = true;
    }
    if (lostCode && !notes.length) notes.push('Some branches now share the main folder.');

    const nodes = payload.nodes
      .filter((n) => n.boardId === old.id)
      .map((n) => (n.kind === 'turn' && (n.status === 'running' || n.status === 'waiting') ? { ...n, status: 'stopped' as const, pending: undefined, learning: false } : n));

    // Conversations: put each transcript where Claude Code looks for it from its branch's folder.
    let restored = 0;
    const byBranch = new Map(branches.map((b) => [b.id, b]));
    const written = new Set<string>();
    for (const n of nodes) {
      if (n.kind !== 'turn' || !n.sessionId || written.has(n.sessionId)) continue;
      const files = transcripts.get(n.sessionId);
      const br = byBranch.get(n.branchId);
      if (!files || !br) continue;
      const dir = projectDir(br.cwd);
      for (const f of files) {
        const target = path.join(dir, f.rel);
        if (!target.startsWith(dir + path.sep)) continue; // never write outside the project folder
        if (fs.existsSync(target)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(f.data, 'base64'));
      }
      written.add(n.sessionId);
      restored++;
    }

    state.boards.push(board);
    state.branches.push(...branches);
    state.nodes.push(...nodes);
    added.boards.push(board);
    added.branches.push(...branches);
    added.nodes.push(...nodes);
    const steps = nodes.filter((n) => n.kind === 'turn').length;
    results.push({
      name: old.name,
      ok: true,
      note: [`${steps} step${steps === 1 ? '' : 's'}, ${restored} conversation${restored === 1 ? '' : 's'}${fetched ? ', code branches' : ''}.`, ...notes].join(' '),
    });
  }
  save();
  pending.delete(id);
  return { results, ...added };
}
