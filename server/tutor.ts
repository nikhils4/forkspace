import { query } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import path from 'node:path';
import { CONCEPT_AREAS, conceptKey, type Board, type Branch, type Lesson, type TurnEvent, type TurnNode } from '../shared/types.ts';
import * as g from './git.ts';
import { getBoard, getBranch, state } from './store.ts';

// The mentor: a small, tool-less model call that watches what the agent just did and
// teaches the most useful idea in it. Same SDK and same sign-in as the agents themselves.

const MODEL = process.env.FORKSPACE_MENTOR_MODEL || 'haiku';
const MIN_GAP_MS = 45_000;
/** The background mentor teaches at most this many concepts per step. Explain is never limited. */
const MAX_PER_STEP = 2;

type Touch = (node: TurnNode) => void;
let touch: Touch = () => {};
export const setTutorTouch = (fn: Touch) => (touch = fn);

// One voice for everyone: plain words, every term explained. No levels, no categories.
const PLAIN =
  'Write for someone new to coding, the way you would explain it to a friend. ' +
  'Start with an everyday comparison (a recipe, a notebook, a shopping list, a sticky note). ' +
  'Then one sentence on what it does in this code. ' +
  'No jargon. If a technical word cannot be avoided, say what it means right away in plain words. ' +
  'Short sentences, about 12 words each. Never use words like "leverage", "utilize", "idempotent" or "abstraction" without explaining them.';

const LESSON_SCHEMA = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      maxItems: 1,
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The textbook name of the idea, lowercase, 1 to 3 words, like "memoization", "http caching", "recursion". Never the title or a sentence. Reuse an existing key exactly when it is the same idea.' },
          area: { type: 'string', enum: [...CONCEPT_AREAS], description: 'Where in tech this concept belongs.' },
          related: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Keys of already-known concepts this one connects to. Only use keys from the list given.' },
          title: { type: 'string', description: 'The idea in plain words a beginner would understand. At most 5 words.' },
          body: { type: 'string', description: 'An everyday comparison, then what it does here. At most 40 words. Simple words, short sentences.' },
          file: { type: 'string', description: 'Relative path of the file this is about, if any.' },
          snippet: { type: 'string', description: 'Up to 6 lines copied from the actual change that show the concept.' },
        },
        required: ['key', 'area', 'title', 'body'],
      },
    },
  },
  required: ['concepts'],
};

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'The textbook name of the main idea, lowercase, 1 to 3 words, like "memoization". Never the title. If it is the same idea as a known concept, use that exact key.' },
    area: { type: 'string', enum: [...CONCEPT_AREAS], description: 'Where in tech this concept belongs.' },
    related: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Keys of known concepts this connects to, from the list given.' },
    title: { type: 'string', description: 'The idea in plain words a beginner would understand. At most 6 words.' },
    body: { type: 'string', description: 'An everyday comparison first, then what happened in this step. At most 70 words. Simple words, short sentences, every term explained.' },
    snippet: { type: 'string', description: 'Up to 8 lines from the change worth looking at.' },
  },
  required: ['key', 'area', 'title', 'body'],
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

/** Every concept learned so far, on every board, by key. A concept is taught once. */
function knownConcepts() {
  const known = new Map<string, string>();
  for (const n of state.nodes) if (n.kind === 'turn') for (const l of n.lessons ?? []) known.set(l.key ?? conceptKey(l.title), l.title);
  return known;
}
const knownList = (known: Map<string, string>) =>
  [...known]
    .slice(-120)
    .map(([k, t]) => `${k} (${t})`)
    .join('; ');
const cleanRelated = (r: unknown, known: Map<string, string>, self: string) =>
  Array.isArray(r) ? [...new Set(r.map((x) => conceptKey(String(x))).filter((k) => k !== self && known.has(k)))].slice(0, 4) : [];
/** A key must be a short name. If the model handed back a sentence, keep its first words. */
const shortKey = (k: unknown, title: string) => {
  const c = conceptKey(String(k || '') || title.split(':')[0]);
  return c.split(' ').slice(0, 4).join(' ');
};
const area = (a: unknown) => ((CONCEPT_AREAS as readonly string[]).includes(String(a)) ? String(a) : undefined);

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
  // Calm by design: a couple of ideas per step is plenty to read while the agent works.
  const taught = (node.lessons ?? []).filter((l) => !l.asked).length;
  if (taught >= MAX_PER_STEP) return;
  const due = final ? fresh.length > 0 && taught === 0 : edits >= 2 && Date.now() - w.lastAt > MIN_GAP_MS;
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
    const known = knownConcepts();
    const prompt =
      `The developer asked the agent: "${clip(node.prompt, 400)}"\n\n` +
      `What the agent just did:\n\n${describe(events, branch)}\n\n` +
      (known.size ? `Concepts the developer already learned (key (title)). Never teach any of these again, under any name: ${knownList(known)}\n\n` : '') +
      `${PLAIN}\n\n` +
      `Pick the single programming concept in this activity that is most worth understanding, the idea behind the code rather than a summary of what changed. ` +
      `If nothing here teaches a real concept (trivial reads, boilerplate), return an empty list.`;
    const res = await ask<{ concepts: { key: string; area: string; related?: string[]; title: string; body: string; file?: string; snippet?: string }[] }>(prompt, SYSTEM, LESSON_SCHEMA, branch?.cwd ?? board.cwd);
    // Belt and braces: drop anything that is already known by key or by title.
    const titles = new Set([...known.values()].map(conceptKey));
    const fresh = (res?.concepts ?? []).filter((l) => l?.title && l?.body && !known.has(shortKey(l.key, l.title)) && !titles.has(conceptKey(l.title)));
    if (fresh.length) {
      node.lessons = [
        ...(node.lessons ?? []),
        ...fresh.map((l) => {
          const key = shortKey(l.key, l.title);
          return { title: l.title, body: l.body, file: l.file, snippet: l.snippet, key, area: area(l.area), related: cleanRelated(l.related, known, key), kind: 'concept' as const, id: nanoid(8), at: Date.now() };
        }),
      ];
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

// ---- on demand: "Explain this step" / "Explain this change" ----

export async function explain(node: TurnNode, file?: string): Promise<Lesson> {
  const board = getBoard(node.boardId);
  const branch = getBranch(node.branchId);
  if (!board || !branch) throw new Error('Board not found');
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

  const known = knownConcepts();
  // Show "Finding a concept…" on the card while the mentor writes.
  node.learning = true;
  touch(node);
  let res: { key: string; area: string; related?: string[]; title: string; body: string; snippet?: string } | null;
  try {
    res = await ask<{ key: string; area: string; related?: string[]; title: string; body: string; snippet?: string }>(
      `The developer asked the agent: "${clip(node.prompt, 400)}"\n\n${subject}\n\nTeach the concept behind it. ${PLAIN}` +
        (known.size ? `\n\nConcepts the developer already knows (key (title)): ${knownList(known)}. If the main idea here is one of them, reuse its exact key, and explain how it shows up in this step.` : ''),
      SYSTEM,
      EXPLAIN_SCHEMA,
      branch.cwd,
    );
  } finally {
    node.learning = false;
    touch(node);
  }
  if (!res?.title) throw new Error('The mentor could not explain that right now. Try again.');
  const key = shortKey(res.key, res.title);
  const lesson: Lesson = { id: nanoid(8), kind: 'concept', title: res.title, body: res.body, snippet: res.snippet, file, at: Date.now(), key, area: area(res.area), related: cleanRelated(res.related, known, key), asked: true };
  node.lessons = [...(node.lessons ?? []), lesson];
  touch(node);
  return lesson;
}

function threadBase(node: TurnNode): string | undefined {
  let cur: any = node;
  while (cur?.parentId) cur = state.nodes.find((n) => n.id === cur.parentId);
  return cur?.baseCommit;
}

// ---- organise older concepts: give each a key and an area, and merge duplicates ----

const ORGANIZE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          key: { type: 'string', description: 'The textbook name of the idea, lowercase, 1 to 3 words, like "memoization", "http caching", "shell quoting". Never the title. Concepts about the same idea MUST share one key.' },
          area: { type: 'string', enum: [...CONCEPT_AREAS] },
          related: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Keys of other concepts in this list it connects to.' },
        },
        required: ['id', 'key', 'area'],
      },
    },
  },
  required: ['items'],
};

let organizing: Promise<number> | null = null;
/** Tag every concept that has no key or area yet. Safe to call often: runs once at a time. */
export function organizeConcepts(cwd: string): Promise<number> {
  organizing ??= (async () => {
    try {
      const all = state.nodes.flatMap((n) => (n.kind === 'turn' ? (n.lessons ?? []).map((l) => ({ l, n })) : []));
      const todo = all.filter(({ l }) => !l.key || !l.area);
      if (!todo.length) return 0;
      const known = knownConcepts();
      // Only properly named concepts are offered for reuse, not raw titles.
      const named = new Map<string, string>();
      for (const n of state.nodes) if (n.kind === 'turn') for (const l of n.lessons ?? []) if (l.key && l.area) named.set(l.key, l.title);
      let done = 0;
      for (let i = 0; i < todo.length; i += 60) {
        const batch = todo.slice(i, i + 60);
        const list = batch.map(({ l }) => `- id ${l.id}: ${l.title}. ${clip(l.body, 220)}`).join('\n');
        const res = await ask<{ items: { id: string; key: string; area: string; related?: string[] }[] }>(
          `Sort these programming concepts a developer learned.\n\n${list}\n\n` +
            (named.size ? `Already named (reuse these keys for the same idea): ${knownList(named)}\n\n` : '') +
            'For each id give its key, the area of tech it belongs to, and which other keys it connects to. ' +
            'Merge duplicates: for example "Memoization: remembering past answers" and "Caching results so repeat calls are instant" are the same idea, so both get the key "memoization".',
          'You organise programming concepts into a clear map. Be consistent: one idea, one key.',
          ORGANIZE_SCHEMA,
          cwd,
        );
        const byId = new Map((res?.items ?? []).map((x) => [x.id, x]));
        for (const { l, n } of batch) {
          const x = byId.get(l.id);
          if (!x) continue;
          l.key = shortKey(x.key, l.title);
          l.area = area(x.area) ?? l.area;
          known.set(l.key, l.title);
          named.set(l.key, l.title);
          touch(n as TurnNode);
          done++;
        }
        for (const { l } of batch) {
          const x = byId.get(l.id);
          if (x && l.key) l.related = cleanRelated(x.related, known, l.key);
        }
      }
      return done;
    } finally {
      organizing = null;
    }
  })();
  return organizing;
}

// ---- commit messages for checkpoints ----

const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string', description: 'One line, at most 72 characters, conventional commit style like "feat: add memoized power()" or "fix(cart): handle empty basket". Imperative mood.' },
    body: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Up to 3 short bullet points on what changed. Empty for small changes.' },
  },
  required: ['subject'],
};

/** Ticket ids like ENG-8788, ABC-12 or #123 mentioned anywhere relevant. */
export function findTickets(...texts: (string | undefined)[]) {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g)) out.add(m[1]);
    // Branch names are often lowercase: nikhil/eng-8788-thing
    for (const m of t.matchAll(/(?:^|[\/_-])([a-z]{2,10}-\d{2,6})(?=$|[\/_-])/g)) out.add(m[1].toUpperCase());
    for (const m of t.matchAll(/(?:^|\s)#(\d{1,6})\b/g)) out.add(`#${m[1]}`);
  }
  return [...out].slice(0, 3);
}

const TYPES: [RegExp, string][] = [
  [/\b(fix|bug|broken|error|crash|wrong|issue)\b/i, 'fix'],
  [/\b(test|tests|spec)\b/i, 'test'],
  [/\b(doc|docs|readme|comment)\b/i, 'docs'],
  [/\b(refactor|clean ?up|rename|simplif)/i, 'refactor'],
  [/\b(style|css|design|ui)\b/i, 'style'],
  [/\b(perf|faster|speed|optimi[sz]e|cache)\b/i, 'perf'],
];

/** Plain fallback when the model is unavailable: still short and conventional. */
function fallbackMessage(prompt: string, summary: string, tickets: string[]) {
  const type = TYPES.find(([re]) => re.test(prompt))?.[1] ?? (/\b(add|create|new|build|implement|support)\b/i.test(prompt) ? 'feat' : 'chore');
  const what = (summary || prompt).replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, '');
  const tail = tickets.length ? ` (${tickets.join(', ')})` : '';
  const room = 72 - type.length - 2 - tail.length;
  return `${type}: ${what.charAt(0).toLowerCase()}${what.slice(1, room)}${what.length > room ? '…' : ''}${tail}`;
}

/** A short conventional commit message for what a step changed, in the repo's own style. */
export async function commitMessage(opts: { prompt: string; history: string[]; summary: string; stat: string; patch: string; recent: string[]; branchName: string; cwd: string }): Promise<{ subject: string; body?: string }> {
  const tickets = findTickets(opts.prompt, ...opts.history, opts.summary, opts.branchName);
  if (!opts.stat.trim()) return { subject: fallbackMessage(opts.prompt, opts.summary, tickets).replace(/^\w+:/, 'chore:') };
  try {
    const res = await ask<{ subject: string; body?: string[] }>(
      `Write the git commit message for these changes.\n\n` +
        `What the developer asked: "${clip(opts.prompt, 500)}"\n` +
        (opts.summary ? `What the agent said it did: ${clip(opts.summary, 700)}\n` : '') +
        `\nFiles:\n${clip(opts.stat, 1500)}\n\nDiff:\n${clip(opts.patch, 6000)}\n\n` +
        (opts.recent.length ? `Recent commits in this repo (match their style, prefix and casing):\n${opts.recent.map((s) => `- ${s}`).join('\n')}\n\n` : '') +
        (tickets.length ? `Ticket(s) this work belongs to: ${tickets.join(', ')}. Include them the way recent commits do, or as "(${tickets[0]})" at the end of the subject.\n\n` : '') +
        'Describe what changed, not what was asked. Conventional commit types: feat, fix, refactor, perf, test, docs, style, chore. No AI or tool attribution, no co-author lines.',
      'You write short, precise git commit messages like a careful senior engineer.',
      COMMIT_SCHEMA,
      opts.cwd,
    );
    const subject = res?.subject?.replace(/\s+/g, ' ').trim();
    if (!subject) throw new Error('empty');
    const body = (res?.body ?? []).map((b) => `- ${b.replace(/^[-*]\s*/, '').trim()}`).join('\n');
    return { subject: subject.slice(0, 100), body: body || undefined };
  } catch {
    return { subject: fallbackMessage(opts.prompt, opts.summary, tickets) };
  }
}

// ---- thread titles, like Claude Code's session titles ----

const TITLE_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string', description: 'A short title for this piece of work, 2 to 6 words, like "Fix cart total for discounts". No quotes, no trailing period.' } },
  required: ['title'],
};

export function fallbackTitle(prompt: string) {
  const words = prompt.replace(/[`*_#>\[\]()]/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function threadTitle(prompt: string, summary: string, cwd: string): Promise<string> {
  try {
    const res = await ask<{ title: string }>(
      `Give this coding task a short title.\n\nWhat the developer asked: "${clip(prompt, 600)}"\n` + (summary ? `What was done: ${clip(summary, 500)}\n` : ''),
      'You name pieces of work with short, clear titles, like a good ticket title.',
      TITLE_SCHEMA,
      cwd,
    );
    const t = res?.title?.replace(/^["']|["'.]$/g, '').replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 80);
  } catch {}
  return fallbackTitle(prompt);
}

// ---- read the text in an image (for notes: "Turn into text") ----

/** Copy out the text in an image, keeping lines and lists. Uses the same small model as concepts. */
export async function readImageText(bytes: Buffer, mediaType: string, cwd: string): Promise<string> {
  async function* input() {
    yield {
      type: 'user' as const,
      parent_tool_use_id: null,
      message: {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType as 'image/png', data: bytes.toString('base64') } },
          {
            type: 'text' as const,
            text:
              'Copy out all the text in this image, exactly, in reading order. Keep line breaks. ' +
              'Write lists as "- item", checkboxes as "- [ ] item" or "- [x] item", and headings as "# Heading". ' +
              'Return only the text, with no comments. If there is no text, return nothing.',
          },
        ],
      },
    };
  }
  const q = query({
    prompt: input() as any,
    options: { model: MODEL, cwd, tools: [], settingSources: [], persistSession: false, maxTurns: 1, systemPrompt: 'You copy text out of images accurately.' },
  });
  let text = '';
  for await (const msg of q as AsyncIterable<any>) {
    if (msg.type === 'result' && msg.subtype === 'success') text = String(msg.result ?? '');
  }
  return text.replace(/^```\w*\n?|```$/g, '').trim();
}
