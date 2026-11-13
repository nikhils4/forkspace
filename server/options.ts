import type { TurnNode } from '../shared/types.ts';
import { touch } from './runner.ts';
import { getBranch, save, state } from './store.ts';
import { findOptions, matchPick } from './tutor.ts';

// When Claude's answer lays out a list of work to pick from (tickets, issues, next steps,
// approaches), the list is kept on the card. Each later step from that card is matched to the item
// it works on, so you can always tell which ticket a branch was for and which are still open.

/** Bump to read answers again after the reading changes. */
const OPT_V = 2;

const lastWords = (t: TurnNode) => {
  for (let i = t.events.length - 1; i >= 0; i--) {
    const e = t.events[i];
    if (e.t === 'text' && !e.partial && e.text.trim()) return e.text;
  }
  return '';
};

// Cheap first look, so most answers never need a model call: a list of at least two items.
const ITEM = /^\s*(\d+[.)]|[-*•]|\(?[a-h][.)]|#{2,4}\s|\*\*[^*]+\*\*\s*[:—-]|option \w+:?|[A-Z][A-Z0-9]+-\d+\b)\s*\S/gm;
export function mightOffer(text: string) {
  return !!text && (text.match(ITEM)?.length ?? 0) >= 2;
}

const kids = (id: string) => state.nodes.filter((n): n is TurnNode => n.kind === 'turn' && n.parentId === id);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const cwdOf = (n: TurnNode) => getBranch(n.branchId)?.cwd ?? process.cwd();

const busy = new Set<string>();

/** Read a finished step's answer for a list of work. */
export async function optionsAfterStep(node: TurnNode) {
  if (node.status !== 'done' || node.optionsV === OPT_V || busy.has(node.id)) return;
  const text = lastWords(node);
  if (!mightOffer(text)) {
    node.optionsChecked = true;
    node.optionsV = OPT_V;
    if (node.options) {
      node.options = undefined;
      touch(node);
    }
    save();
    return;
  }
  busy.add(node.id);
  try {
    const options = await findOptions(text, node.prompt, cwdOf(node));
    node.optionsChecked = true;
    node.optionsV = OPT_V;
    node.options = options.length >= 2 ? options.map((o) => ({ label: o.label.trim(), ...(o.detail?.trim() ? { detail: o.detail.trim() } : {}), prompt: o.prompt.trim() })) : undefined;
    touch(node);
    save();
    // Steps already taken from here: which item did each go with?
    for (const k of kids(node.id)) {
      k.pickedChecked = false;
      void pickAfterStart(k);
    }
  } catch {
    // Try again next start.
  } finally {
    busy.delete(node.id);
  }
}

const picking = new Set<string>();

/** A new step under a card with a list: which item is it working on? */
export async function pickAfterStart(node: TurnNode) {
  if (node.pickedChecked || picking.has(node.id) || !node.parentId) return;
  const parent = state.nodes.find((n): n is TurnNode => n.kind === 'turn' && n.id === node.parentId);
  const list = parent?.options;
  if (!list?.length) return;
  picking.add(node.id);
  try {
    // Used straight from the list: the prompt is the item's own words.
    const p = norm(node.prompt);
    let index = list.findIndex((o) => p.includes(norm(o.prompt).slice(0, 48)));
    if (index < 0) {
      // A ticket id in the message settles it.
      const ids = list.map((o) => o.label.match(/\b[A-Z][A-Z0-9]+-\d+\b|#\d+\b/)?.[0]);
      const hits = ids.map((id, i) => (id && node.prompt.includes(id) ? i : -1)).filter((i) => i >= 0);
      if (hits.length === 1) index = hits[0];
    }
    if (index < 0) index = await matchPick(node.prompt, list.map((o) => (o.detail ? `${o.label} (${o.detail})` : o.label)), cwdOf(node));
    node.pickedChecked = true;
    node.picked = index >= 0 ? { index, label: list[index].label } : undefined;
    touch(node);
    save();
  } catch {
    // Try again next time it moves.
  } finally {
    picking.delete(node.id);
  }
}

/** On start: read recent steps not read this way yet, a few at a time. */
export async function backfillOptions(limit = 40) {
  const list = state.nodes
    .filter((n): n is TurnNode => n.kind === 'turn' && n.status === 'done' && n.optionsV !== OPT_V)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
  for (const n of list) await optionsAfterStep(n);
}
