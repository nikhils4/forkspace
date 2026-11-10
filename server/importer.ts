import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import type { Board, Branch, ImportableSession, Position, TurnEvent, TurnNode } from '../shared/types.ts';
import { save, state } from './store.ts';

// Bring existing Claude Code sessions (VS Code extension, CLI) for a folder onto a board.
// Each prompt becomes a card; every card remembers where it ended in the transcript,
// so you can continue or branch from exactly that point.

const MAX_TURNS = 150;

/** Sessions Forkspace itself started; never offer these. */
function ownSessions() {
  const s = new Set<string>();
  for (const n of state.nodes) if (n.kind === 'turn' && n.sessionId && !n.imported) s.add(n.sessionId);
  return s;
}

export async function listImportable(board: Board): Promise<ImportableSession[]> {
  const own = ownSessions();
  const done = new Set(board.imported ?? []);
  const list = await listSessions({ dir: board.cwd, limit: 80, includeWorktrees: false, includeProgrammatic: true } as any);
  return list
    .filter((s) => !own.has(s.sessionId))
    .map((s) => ({
      sessionId: s.sessionId,
      title: clean(s.customTitle || s.summary || s.firstPrompt || 'Untitled session').slice(0, 140),
      firstPrompt: s.firstPrompt ? clean(s.firstPrompt).slice(0, 200) : undefined,
      lastModified: s.lastModified,
      gitBranch: s.gitBranch,
      sizeKb: s.fileSize ? Math.round(s.fileSize / 1024) : undefined,
      imported: done.has(s.sessionId),
    }))
    .sort((a, b) => b.lastModified - a.lastModified);
}

/** Strip editor context the extension attaches to prompts (selections, opened files, reminders). */
function clean(text: string) {
  return text
    .replace(/<(ide_[a-z_]+|system-reminder|command-[a-z]+|local-command-[a-z]+)>[\s\S]*?<\/\1>/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function promptOf(m: any): string | null {
  if (m.type !== 'user' || m.parent_tool_use_id) return null;
  const c = m.message?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b: any) => b?.type === 'tool_result')) return null;
    text = c
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  const t = clean(text);
  if (!t || t.startsWith('Caveat:')) return null;
  return t;
}

const clip = (s: string, n = 6000) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s);

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : JSON.stringify(c))).join('\n');
  return JSON.stringify(content ?? '');
}

interface Draft {
  prompt: string;
  events: TurnEvent[];
  lastUuid: string;
}

async function readTurns(board: Board, sessionId: string): Promise<Draft[]> {
  const msgs = await getSessionMessages(sessionId, { dir: board.cwd });
  const turns: Draft[] = [];
  let cur: Draft | null = null;
  for (const m of msgs as any[]) {
    if (m.parent_tool_use_id) continue; // subagent internals
    const prompt = promptOf(m);
    if (prompt) {
      cur = { prompt, events: [], lastUuid: m.uuid };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lastUuid = m.uuid;
    const content = m.message?.content;
    if (m.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text?.trim()) cur.events.push({ t: 'text', text: b.text });
        else if (b.type === 'tool_use') cur.events.push({ t: 'tool', id: b.id, name: b.name, input: b.input });
      }
    } else if (m.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue;
        const ev = cur.events.find((e) => e.t === 'tool' && e.id === b.tool_use_id);
        if (ev && ev.t === 'tool') {
          ev.result = clip(resultText(b.content));
          ev.isError = !!b.is_error;
        }
      }
    }
  }
  // Tool calls that never got a result (interrupted) shouldn't look like they are still running.
  for (const t of turns) for (const e of t.events) if (e.t === 'tool' && e.result == null) e.result = '';
  return turns.slice(-MAX_TURNS);
}

export async function importSessions(board: Board, ids: string[], at: Position) {
  const created: { branch: Branch; nodes: TurnNode[] }[] = [];
  let x = at.x;
  for (const sessionId of ids) {
    if (board.imported?.includes(sessionId)) continue;
    const turns = await readTurns(board, sessionId);
    if (!turns.length) continue;
    // Imported threads run in the board's own folder, exactly where the original session worked.
    const branch: Branch = { id: nanoid(8), boardId: board.id, cwd: board.cwd, imported: true };
    const nodes: TurnNode[] = [];
    const now = Date.now();
    let y = at.y;
    turns.forEach((t, i) => {
      const node: TurnNode = {
        kind: 'turn',
        id: nanoid(10),
        boardId: board.id,
        parentId: nodes[i - 1]?.id ?? null,
        branchId: branch.id,
        prompt: t.prompt,
        events: t.events,
        status: 'done',
        sessionId,
        resumeAt: t.lastUuid,
        imported: true,
        position: { x, y },
        createdAt: now - (turns.length - i) * 1000,
        finishedAt: now - (turns.length - i) * 1000 + 500,
      };
      nodes.push(node);
      y += 330;
    });
    branch.headNodeId = nodes[nodes.length - 1].id;
    state.branches.push(branch);
    state.nodes.push(...nodes);
    board.imported = [...(board.imported ?? []), sessionId];
    created.push({ branch, nodes });
    x += 460;
  }
  save();
  return created;
}
