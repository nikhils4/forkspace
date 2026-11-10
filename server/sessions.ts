import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code keeps transcripts per working directory:
//   <config>/projects/<cwd with every non-alphanumeric char as '-'>/<sessionId>.jsonl
// A fork that moves to a new worktree changes cwd, so the parent transcript has to be
// visible from the new folder before we can resume it there.

const CONFIG = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS = path.join(CONFIG, 'projects');

export const projectDir = (cwd: string) => path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'));

function findSession(sessionId: string): string | null {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(PROJECTS);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(PROJECTS, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return path.join(PROJECTS, d);
  }
  return null;
}

/** Make `sessionId` resumable from `cwd`. Safe because Forkspace always resumes with forkSession. */
export function ensureSessionAt(sessionId: string, cwd: string) {
  const target = projectDir(cwd);
  if (fs.existsSync(path.join(target, `${sessionId}.jsonl`))) return;
  const source = findSession(sessionId);
  if (!source) throw new Error(`Transcript for session ${sessionId} not found under ${PROJECTS}`);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(source, `${sessionId}.jsonl`), path.join(target, `${sessionId}.jsonl`));
  const extras = path.join(source, sessionId);
  if (fs.existsSync(extras)) fs.cpSync(extras, path.join(target, sessionId), { recursive: true });
}
