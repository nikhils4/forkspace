import { query } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import path from 'node:path';
import type { Board, Branch, LearnLevel, Lesson, TurnEvent, TurnNode } from '../shared/types.ts';
import * as g from './git.ts';
import { getBoard, getBranch, state } from './store.ts';

// The mentor: a small, tool-less model call that watches what the agent just did and
// teaches the most useful idea in it. Same SDK and same sign-in as the agents themselves.

const MODEL = process.env.FORKSPACE_MENTOR_MODEL || 'haiku';
const MIN_GAP_MS = 12_000;

type Touch = (node: TurnNode) => void;
let touch: Touch = () => {};
export const setTutorTouch = (fn: Touch) => (touch = fn);

const LEVEL: Record<LearnLevel, string> = {
  new: 'The reader is new to programming. Use everyday words, one idea at a time, and define any jargon you use.',
  growing: 'The reader can code but is still growing. Name the concept properly and explain why it matters here.',
  expert: 'The reader is experienced. Skip basics. Focus on trade-offs, edge cases and the non-obvious choice the agent made.',
};

const LESSON_SCHEMA = {
  type: 'object',
  properties: {
    lessons: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['concept', 'why', 'pattern', 'watch'] },
          title: { type: 'string', description: 'At most 6 words.' },
          body: { type: 'string', description: 'At most 60 words, plain language, no markdown headings.' },
          file: { type: 'string', description: 'Relative path of the file this is about, if any.' },
          snippet: { type: 'string', description: 'Up to 6 lines copied from the actual change that show the idea.' },
          check: {
            type: 'object',
            description: 'Optional quick question to check understanding. Use for at most one lesson.',
            properties: {
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
              answer: { type: 'integer', description: 'Index of the correct option.' },
              why: { type: 'string', description: 'One sentence on why that answer is right.' },
            },
            required: ['question', 'options', 'answer'],
          },
        },
        required: ['kind', 'title', 'body'],
      },
    },
  },
  required: ['lessons'],
};

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'At most 7 words.' },
    body: { type: 'string', description: 'At most 140 words. Short paragraphs or a few "- " bullets. Plain language.' },
    snippet: { type: 'string', description: 'Up to 8 lines from the change worth looking at.' },
  },
  required: ['title', 'body'],
};

const clip = (s: unknown, n: number) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  return t.length > n ? t.slice(0, n) + ' …' : t;
};

function rel(branch: Branch | undefined, p: unknown) {
  if (typeof p !== 'string' || !branch) return p;
  return p.startsWith(branch.cwd + '/') ? p.slice(branch.cwd.length + 1) : p;
}

/** A compact, model-friendly account of what happened in these events. */
function describe(events: TurnEvent[], branch?: Branch): string {
  const out: string[] = [];
  for (const e of events) {
    if (e.t === 'text' && !e.partial) out.push(`Agent said: ${clip(e.text, 500)}`);
    if (e.t !== 'tool') continue;
    const i = (e.input ?? {}) as any;
    switch (e.name) {
      case 'Edit':
        out.push(`Edited ${rel(branch, i.file_path)}\n--- before\n${clip(i.old_string, 700)}\n+++ after\n${clip(i.new_string, 900)}`);
        break;
      case 'MultiEdit':
        out.push(`Edited ${rel(branch, i.file_path)} in ${i.edits?.length ?? 'several'} places: ${clip(i.edits?.map((x: any) => x.new_string).join('\n…\n'), 900)}`);
        break;
      case 'Write':
        out.push(`Wrote ${rel(branch, i.file_path)}:\n${clip(i.content, 1200)}`);
        break;
      case 'Bash':
        out.push(`Ran: ${clip(i.command, 200)}${e.result != null ? `\nOutput: ${clip(e.result, 300)}` : ''}`);
        break;
      case 'Read':
        out.push(`Read ${rel(branch, i.file_path)}`);
        break;
      default:
        out.push(`${e.name}: ${clip(i.pattern ?? i.url ?? i.query ?? i.description ?? '', 150)}`);
    }
  }
  return out.join('\n\n');
}

const learnedTitles = (boardId: string) =>
  state.nodes
    .flatMap((n) => (n.kind === 'turn' && n.boardId === boardId ? (n.lessons ?? []) : []))
    .map((l) => l.title)
    .slice(-50);

async function ask<T>(prompt: string, system: string, schema: object, cwd: string): Promise<T | null> {
  const q = query({
    prompt,
    options: {
      model: MODEL,
      cwd,
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 3,
      systemPrompt: system,
      outputFormat: { type: 'json_schema', schema: schema as Record<string, unknown> },
    },
  });
  let result: T | null = null;
  for await (const msg of q as AsyncIterable<any>) {
    if (msg.type === 'result' && msg.subtype === 'success') result = (msg.structured_output as T) ?? null;
  }
  return result;
}

const SYSTEM =
  'You are a friendly senior engineer sitting next to a developer while an AI coding agent works in their project. ' +
  'Your job is to help the developer understand and learn from what the agent is doing, so they grow instead of just watching. ' +
  'Be concrete: tie every point to the actual code or command. Never invent code that is not in the activity. Never pad.';

// ---- live lessons while the agent works ----

interface Watch {
  cursor: number;
  lastAt: number;
  busy: boolean;
  pending: boolean;
}
const watches = new Map<string, Watch>();

/** Called by the runner whenever a tool finishes, and once when the turn ends. */
export function onActivity(node: TurnNode, final = false) {
  const board = getBoard(node.boardId);
  if (!board || board.learn?.on === false) return;
  const w = watches.get(node.id) ?? { cursor: 0, lastAt: 0, busy: false, pending: false };
  watches.set(node.id, w);
  const fresh = node.events.slice(w.cursor);
  const edits = fresh.filter((e) => e.t === 'tool' && e.result != null && ['Edit', 'Write', 'MultiEdit', 'Bash'].includes(e.name)).length;
  const due = final ? fresh.length > 0 : edits >= 2 && Date.now() - w.lastAt > MIN_GAP_MS;
  if (!due) return;
  if (w.busy) {
    w.pending = true;
    return;
  }
  void teach(board, node, w, final);
}

async function teach(board: Board, node: TurnNode, w: Watch, final: boolean) {
  const branch = getBranch(node.branchId);
  const events = node.events.slice(w.cursor);
  w.cursor = node.events.length;
  w.busy = true;
  w.lastAt = Date.now();
  node.learning = true;
  touch(node);
  try {
    const level = board.learn?.level ?? 'growing';
    const known = learnedTitles(board.id);
    const prompt =
      `The developer asked the agent: "${clip(node.prompt, 400)}"\n\n` +
      `What the agent just did:\n\n${describe(events, branch)}\n\n` +
      (known.length ? `Already taught on this project (do not repeat): ${known.join('; ')}\n\n` : '') +
      `${LEVEL[level]}\n\n` +
      `Pick the one or two ideas from this activity that are most worth learning: a concept, why the agent chose this approach, a pattern worth reusing, or something to watch out for. ` +
      `If nothing here is worth teaching (trivial reads, boilerplate), return an empty list.`;
    const res = await ask<{ lessons: Omit<Lesson, 'id' | 'at'>[] }>(prompt, SYSTEM, LESSON_SCHEMA, branch?.cwd ?? board.cwd);
    const fresh = (res?.lessons ?? []).filter((l) => l?.title && l?.body && !known.includes(l.title));
    if (fresh.length) {
      node.lessons = [...(node.lessons ?? []), ...fresh.map((l) => ({ ...l, check: validCheck(l.check), id: nanoid(8), at: Date.now() }))];
    }
  } catch (err) {
    console.error('[mentor]', (err as Error).message);
  } finally {
    w.busy = false;
    node.learning = false;
    touch(node);
    if (w.pending) {
      w.pending = false;
      onActivity(node, final);
    }
    if (final && !w.pending) watches.delete(node.id);
  }
}

function validCheck(c: Lesson['check']): Lesson['check'] {
  if (!c || !Array.isArray(c.options) || c.options.length < 2) return undefined;
  if (typeof c.answer !== 'number' || c.answer < 0 || c.answer >= c.options.length) return undefined;
  return c;
}

// ---- on demand: "Explain this step" / "Explain this change" ----

export async function explain(node: TurnNode, file?: string): Promise<Lesson> {
  const board = getBoard(node.boardId);
  const branch = getBranch(node.branchId);
  if (!board || !branch) throw new Error('Board not found');
  const level = board.learn?.level ?? 'growing';

  let subject: string;
  if (file) {
    const abs = path.resolve(branch.cwd, file);
    if (!abs.startsWith(branch.cwd + path.sep)) throw new Error('Path is outside the project');
    let diff = '';
    if (board.repoRoot) {
      const base = threadBase(node) ?? 'HEAD';
      diff = await g.git(branch.cwd, 'diff', '--no-color', base, '--', file).catch(() => '');
      if (!diff) diff = await g.git(branch.cwd, 'diff', '--no-color', '--no-index', '/dev/null', file).catch((e: any) => String(e?.stdout ?? ''));
    }
    subject = `Explain the change to ${file} on this branch.\n\nDiff:\n${clip(diff || '(no diff available)', 9000)}`;
  } else {
    subject = `Explain what the agent did in this step and why, so the developer could do it themselves next time.\n\nWhat happened:\n${describe(node.events, branch)}`;
  }

  const res = await ask<{ title: string; body: string; snippet?: string }>(
    `The developer asked the agent: "${clip(node.prompt, 400)}"\n\n${subject}\n\n${LEVEL[level]}`,
    SYSTEM,
    EXPLAIN_SCHEMA,
    branch.cwd,
  );
  if (!res?.title) throw new Error('The mentor could not explain that right now. Try again.');
  const lesson: Lesson = { id: nanoid(8), kind: 'explain', title: res.title, body: res.body, snippet: res.snippet, file, at: Date.now() };
  node.lessons = [...(node.lessons ?? []), lesson];
  touch(node);
  return lesson;
}

function threadBase(node: TurnNode): string | undefined {
  let cur: any = node;
  while (cur?.parentId) cur = state.nodes.find((n) => n.id === cur.parentId);
  return cur?.baseCommit;
}
