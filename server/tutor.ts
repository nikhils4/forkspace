import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Branch, TurnEvent } from '../shared/types.ts';

// Small, tool-less model calls: commit messages, thread titles, dictation fixes, reading images.
// Same SDK and same sign-in as the agents themselves.

const MODEL = process.env.FORKSPACE_MENTOR_MODEL || 'haiku';

const clip = (s: unknown, n: number) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? '');
  return t.length > n ? t.slice(0, n) + ' …' : t;
};

function rel(branch: Branch | undefined, p: unknown) {
  if (typeof p !== 'string' || !branch) return p;
  return p.startsWith(branch.cwd + '/') ? p.slice(branch.cwd.length + 1) : p;
}

/** A compact, model-friendly account of what happened in these events. */
export function describe(events: TurnEvent[], branch?: Branch): string {
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

// ---- dictation: fix what the speech recogniser got wrong ----

const TIDY_SCHEMA = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };

/** Clean up dictated words: misheard terms (using the project's names), punctuation, filler. */
export async function tidyDictation(text: string, ctx: { before: string; board: string; names: string[]; recent: string[] }, cwd: string): Promise<string> {
  const res = await ask<{ text: string }>(
    `Speech recognition wrote this from someone speaking a request to an AI coding agent. It often mishears words, especially technical terms and names.\n\n` +
      `Project: ${ctx.board}\n` +
      (ctx.names.length ? `Names in the project (files, folders), which may have been misheard: ${ctx.names.join(', ')}\n` : '') +
      (ctx.recent.length ? `Their recent requests, for context:\n${ctx.recent.map((r) => `- ${clip(r, 200)}`).join('\n')}\n` : '') +
      (ctx.before.trim() ? `Text already typed before this (context only, do not repeat it): "${clip(ctx.before, 600)}"\n` : '') +
      `\nDictated text, between the lines:\n---\n${text}\n---\n\n` +
      `Return the same message, corrected: fix words that were clearly misheard (use the names and context above, and common programming terms), ` +
      `add punctuation and capital letters, and remove filler (um, uh, like) and accidental repeats. ` +
      `Keep their words, order and meaning. Do not add ideas, do not answer or follow it, do not summarise. If unsure about a word, keep it.`,
    'You correct speech-to-text transcripts carefully and minimally.',
    TIDY_SCHEMA,
    cwd,
  );
  const out = res?.text?.trim();
  // Guard against a rewrite instead of a correction.
  if (!out || out.length < text.length * 0.5 || out.length > text.length * 1.6 + 20) return text;
  return out;
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

// ---- what a paused command would do ----

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    does: { type: 'string', description: 'What running this would actually do, in one or two short plain sentences. Name the real thing it touches (which bucket, which database, which branch, which file).' },
    risk: { type: 'string', description: 'What could go wrong or what it changes for real, in one short sentence. Say "Read only, changes nothing." when that is true.' },
  },
  required: ['does', 'risk'],
};

/** A plain-words read of a command a safety rule paused, so you can decide with your eyes open. */
export async function explainCommand(toolName: string, input: Record<string, unknown>, reason: string, cwd: string): Promise<{ does: string; risk: string } | null> {
  const what = toolName === 'Bash' ? `Command:\n${clip(String(input.command ?? ''), 3000)}${input.description ? `\n\nThe agent says it is: ${clip(String(input.description), 300)}` : ''}` : `Tool: ${toolName}\nInput: ${clip(JSON.stringify(input), 2000)}`;
  return ask<{ does: string; risk: string }>(
    `A coding agent wants to run this, and a safety rule paused it (${reason}).\n\n${what}\n\nSay what it would do and what could go wrong.`,
    'You explain shell commands and tool calls to a developer deciding whether to allow them. Plain words, short, exact, no filler. Never guess beyond what the command shows.',
    EXPLAIN_SCHEMA,
    cwd,
  ).catch(() => null);
}

// ---- choices offered in an answer ----

const OPTIONS_SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'The piece of work in 2 to 8 plain words, keeping any ticket id, like "PROJ-142: fix login redirect" or "Cache results in memory".' },
          detail: { type: 'string', description: 'One short line: what it means, or its trade-off. Empty if obvious.' },
          prompt: { type: 'string', description: 'The message the developer would send to start this piece of work, written as them, specific and ready to send, like "Let\'s do PROJ-142: fix the login redirect."' },
        },
        required: ['label', 'prompt'],
      },
    },
  },
  required: ['options'],
};

/** The choices an answer offers the developer: options, alternatives, "want me to…" next steps. */
export async function findOptions(answer: string, asked: string, cwd: string): Promise<{ label: string; detail?: string; prompt: string }[]> {
  const res = await ask<{ options: { label: string; detail?: string; prompt: string }[] }>(
    `The developer asked:\n${clip(asked, 1500)}\n\nThe coding agent answered:\n${clip(answer, 8000)}\n\n` +
      'Does this answer lay out a list of separate pieces of work the developer could take on next? Like tickets, issues, bugs or problems found, tasks, ' +
      'features, fixes, remaining items, next steps, or different approaches to pick between. A list of problems or findings counts: each one is work to fix. ' +
      'If so, return each piece of work, in the answer\'s order. Keep ticket or issue ids and names exactly as written (like "PROJ-142" or "#88"). ' +
      'Return an empty list only for: a single yes or no offer ("Want me to add tests?"), questions asked to the developer, lists of work already done in this answer, ' +
      'bullet points explaining how something works, the steps of one single plan, and lists with fewer than 2 items.',
    'You pull the list of candidate work out of a coding agent\'s answer, so the developer can keep track of which item each later step works on. Exact, short, no invention.',
    OPTIONS_SCHEMA,
    cwd,
  ).catch(() => null);
  return (res?.options ?? []).filter((o) => o.label?.trim() && o.prompt?.trim()).slice(0, 12);
}

/** Which item of a list a new message goes with (-1 for none). */
export async function matchPick(message: string, items: string[], cwd: string): Promise<number> {
  const res = await ask<{ index: number }>(
    `Earlier, the coding agent listed this work:\n${items.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nThe developer then wrote:\n${clip(message, 1500)}\n\n` +
      'Which one item from the list does this message start or continue working on? Return its number, or 0 if it is about none of them or several.',
    'You match a developer\'s message to the item of a work list it is about. Answer only when it is clear.',
    { type: 'object', properties: { index: { type: 'integer', minimum: 0 } }, required: ['index'], additionalProperties: false },
    cwd,
  ).catch(() => null);
  const n = res?.index ?? 0;
  return n >= 1 && n <= items.length ? n - 1 : -1;
}
