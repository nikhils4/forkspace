import { query } from '@anthropic-ai/claude-agent-sdk';
import { nanoid } from 'nanoid';
import path from 'node:path';
import type { Aside, TurnNode } from '../shared/types.ts';
import { check, safetyHooks } from './guard.ts';
import { touch } from './runner.ts';
import { ensureSessionAt } from './sessions.ts';
import { getBoard, getBranch, state } from './store.ts';

// Quick side questions: select part of a card's answer, ask "what is this?", read the answer
// beside it, move on. The question runs on a throwaway copy of the card's conversation (so it
// knows everything the agent knew), may read the code, never changes anything, and is never
// added to the thread.

const MODEL = process.env.FORKSPACE_ASK_MODEL || 'sonnet';
const READ_ONLY = ['Read', 'Grep', 'Glob'];
const running = new Map<string, AbortController>();

const SYSTEM = `You answer a developer's quick side question about part of an earlier answer, while they read it.
Be brief: two to six sentences, or a few short bullets. Plain words first, then the specifics.
When they ask what something means, say what it is, why it is there, and what it means for the product or the user, not only the code.
You may read the code (Read, Grep, Glob) to be accurate. Never change anything. Cite files as path:line when useful.`;

// Answers cut off by a restart can't continue.
for (const n of state.nodes)
  if (n.kind === 'turn')
    for (const a of n.asides ?? [])
      if (a.busy) Object.assign(a, { busy: undefined, doing: undefined, error: a.answer ? undefined : 'Stopped when Forkspace restarted.' });

const lastText = (node: TurnNode) => {
  for (const e of [...node.events].reverse()) if (e.t === 'text' && !e.partial && e.text.trim()) return e.text;
  return '';
};

export function askAside(node: TurnNode, quote: string, question: string): Aside {
  const branch = getBranch(node.branchId);
  const board = getBoard(node.boardId);
  if (!branch || !board) throw new Error('Card not found');
  const aside: Aside = { id: nanoid(8), quote: quote.slice(0, 4000), question: question.slice(0, 2000), answer: '', at: Date.now(), busy: true };
  node.asides = [...(node.asides ?? []), aside].slice(-30);
  touch(node);

  const abort = new AbortController();
  running.set(aside.id, abort);
  // Resuming the card's own conversation gives the full context. Without one (still on its first
  // step, or made elsewhere), the question carries the card's prompt and answer itself.
  let resume: string | undefined;
  if (node.sessionId)
    try {
      ensureSessionAt(node.sessionId, branch.cwd);
      resume = node.sessionId;
    } catch {}
  const context = resume ? '' : `The task was:\n${node.prompt}\n\nThe answer was:\n${lastText(node).slice(0, 12000)}\n\n`;
  const prompt = `${context}Side question about this part of the answer:\n"""\n${aside.quote}\n"""\n\n${aside.question}`;

  void (async () => {
    try {
      const q = query({
        prompt,
        options: {
          model: MODEL,
          cwd: branch.cwd,
          ...(resume ? { resume, forkSession: true } : {}),
          persistSession: false,
          tools: READ_ONLY,
          allowedTools: READ_ONLY,
          maxTurns: 12,
          abortController: abort,
          includePartialMessages: true,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM },
          settingSources: [],
          hooks: safetyHooks,
          canUseTool: async (name, input) =>
            READ_ONLY.includes(name) && !check(name, input) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Side questions only read the code.' },
        },
      });
      let current = '';
      for await (const msg of q as AsyncIterable<any>) {
        if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event.delta?.type === 'text_delta') {
          current += msg.event.delta.text;
          aside.answer = current;
          aside.doing = undefined;
          touch(node);
        } else if (msg.type === 'assistant') {
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_use') {
              const i = b.input ?? {};
              const what = i.file_path ? path.relative(branch.cwd, String(i.file_path)) : i.pattern ? `“${String(i.pattern).slice(0, 40)}”` : '';
              aside.doing = `${b.name === 'Read' ? 'Reading' : b.name === 'Grep' ? 'Searching for' : 'Looking for'} ${what}`;
              // Text before a tool call was thinking aloud; the answer is what comes after.
              current = '';
              touch(node);
            }
          }
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success' && typeof msg.result === 'string' && msg.result.trim()) aside.answer = msg.result.trim();
          else if (msg.subtype !== 'success') aside.error = msg.subtype === 'error_max_turns' ? 'It took too long. Try a narrower question.' : 'Could not answer that.';
        }
      }
    } catch (e: any) {
      if (!abort.signal.aborted) aside.error = String(e?.message ?? e).slice(0, 300);
    } finally {
      running.delete(aside.id);
      aside.busy = undefined;
      aside.doing = undefined;
      touch(node);
    }
  })();
  return aside;
}

export function dropAside(node: TurnNode, id: string) {
  running.get(id)?.abort();
  node.asides = (node.asides ?? []).filter((a) => a.id !== id);
  if (!node.asides.length) node.asides = undefined;
  touch(node);
}
