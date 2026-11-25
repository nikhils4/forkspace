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
