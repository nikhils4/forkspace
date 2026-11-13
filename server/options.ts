import type { TurnNode } from '../shared/types.ts';
import { touch } from './runner.ts';
import { getBranch, save, state } from './store.ts';
import { findOptions } from './tutor.ts';

// When Claude ends an answer with choices ("Option A… Option B…", "Want me to add tests?"), they
// get pulled out and kept on the card, so you can see later which options you had at that step
// and take one with a click.

const lastWords = (t: TurnNode) => {
  for (let i = t.events.length - 1; i >= 0; i--) {
    const e = t.events[i];
    if (e.t === 'text' && !e.partial && e.text.trim()) return e.text;
  }
  return '';
};

// Cheap first look, so most answers never need a model call.
const OFFERS =
  /\b(options?|alternatively|alternatives?|approach(es)?|either|would you like|want me to|do you want|shall i|should i|i can (also|either)|or i can|choose|pick|prefer|which (one|approach|way|would)|next steps?|you could|we could|happy to)\b/i;
const LIST = /^\s*(\d+[.)]|[-*•]|\(?[a-e][.)]|option \w+:?)\s+\S/im;

export function mightOffer(text: string) {
  if (!text) return false;
  return OFFERS.test(text) && (LIST.test(text) || /\?\s*$/.test(text.trim()) || /\?/.test(text.slice(-400)));
}

const busy = new Set<string>();

/** Read a finished step's answer for options. */
export async function optionsAfterStep(node: TurnNode) {
  if (node.status !== 'done' || node.optionsChecked || busy.has(node.id)) return;
  const text = lastWords(node);
  if (!mightOffer(text)) {
    node.optionsChecked = true;
    save();
    return;
  }
  busy.add(node.id);
  try {
    const cwd = getBranch(node.branchId)?.cwd ?? process.cwd();
    const options = await findOptions(text, node.prompt, cwd);
    node.optionsChecked = true;
    node.options = options.length ? options.map((o) => ({ label: o.label.trim(), ...(o.detail?.trim() ? { detail: o.detail.trim() } : {}), prompt: o.prompt.trim() })) : undefined;
    touch(node);
    save();
  } catch {
    // Try again next start.
  } finally {
    busy.delete(node.id);
  }
}

/** On start: read recent steps finished before this existed, a few at a time. */
export async function backfillOptions(limit = 40) {
  const list = state.nodes
    .filter((n): n is TurnNode => n.kind === 'turn' && n.status === 'done' && !n.optionsChecked)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
  for (const n of list) await optionsAfterStep(n);
}
