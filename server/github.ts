import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Branch, PrInfo, PrItem, ServerMsg, TurnNode } from '../shared/types.ts';
import * as g from './git.ts';
import { getBranch, save, state } from './store.ts';

// Each branch can carry the GitHub pull request its work went into. Forkspace finds it on its own
// (a PR link the agent printed, or an open PR for the worktree's git branch), or you paste one.
// Then it keeps reading it with your `gh` login: failing checks, open review threads from bug bots
// and from people, merge conflicts. With nothing left, the branch shows as ready to merge.

const run = promisify(execFile);
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const POLL_MS = Number(process.env.FORKSPACE_PR_POLL_MS) || 2 * 60_000;
const FIND_MS = 5 * 60_000;
const QUIET_DAYS = 14;

let emit: (m: ServerMsg) => void = () => {};
export const setPrEmit = (fn: (m: ServerMsg) => void) => (emit = fn);
const push = (b: Branch) => emit({ type: 'branch', branch: b });

let ghOk: boolean | null = null;
let ghAskedAt = 0;
async function gh(cwd: string, ...args: string[]) {
  const { stdout } = await run('gh', args, { cwd, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}
/** Is the GitHub CLI installed and signed in? A yes is kept; a no is asked again a minute later
 * (offline at start, a login fixed since). `gh auth token` only looks at the account in use, where
 * `gh auth status` fails when any other saved account has an expired login. */
async function haveGh() {
  if (ghOk || (ghOk === false && Date.now() - ghAskedAt < 60_000)) return ghOk;
  ghAskedAt = Date.now();
  ghOk = await run('gh', ['auth', 'token'], { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  return ghOk;
}

export const parsePrUrl = (s: string) => {
  const m = s.match(PR_URL);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` } : null;
};

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** A bot's comment, cut to the part that says what is wrong (no badges, hidden markers or footers). */
const tidy = (s: string) =>
  s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<details>[\s\S]*?<\/details>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** First real line of a comment, as a one-line title. */
const firstLine = (body: string, fallback: string) =>
  clip((body.split('\n').find((l) => l.trim()) ?? fallback).replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '').trim() || fallback, 140);

const QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
  number url title state isDraft mergeable reviewDecision author{login}
  commits(last:1){nodes{commit{committedDate statusCheckRollup{state contexts(first:100){nodes{
    __typename ... on CheckRun{name status conclusion detailsUrl startedAt completedAt checkSuite{workflowRun{workflow{name}}}}
    ... on StatusContext{context state targetUrl createdAt}}}}}}}
  reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:1){nodes{author{__typename login} body url}}}}
  comments(last:40){nodes{author{__typename login} body url createdAt}}
}}}`;

/** Read a pull request from GitHub and boil it down to what still needs doing. */
export async function readPr(url: string, cwd: string): Promise<PrInfo> {
  const ref = parsePrUrl(url);
  if (!ref) throw new Error('That is not a GitHub pull request link.');
  const raw = await gh(cwd, 'api', 'graphql', '-f', `query=${QUERY}`, '-F', `o=${ref.owner}`, '-F', `r=${ref.repo}`, '-F', `n=${ref.number}`);
  const pr = JSON.parse(raw)?.data?.repository?.pullRequest;
  if (!pr) throw new Error('GitHub did not return that pull request.');

  const items: PrItem[] = [];
  const last = pr.commits?.nodes?.[0]?.commit;
  const rollup = last?.statusCheckRollup;
  // A check that was re-run stays in the list next to its new run, so the old failure would still
  // count. Keep only the latest run of each check, the way GitHub's own page (and gh pr checks) do.
  const latest = new Map<string, any>();
  const when = (c: any) => Date.parse(c.startedAt ?? c.completedAt ?? c.createdAt ?? '') || 0;
  for (const c of (rollup?.contexts?.nodes ?? []) as any[]) {
    const key = c.__typename === 'CheckRun' ? `${c.checkSuite?.workflowRun?.workflow?.name ?? ''}/${c.name}` : `status/${c.context}`;
    const had = latest.get(key);
    if (!had || when(c) >= when(had)) latest.set(key, c);
  }
  // GitHub's own verdict for the commit wins when it says everything passed.
  const allGreen = rollup?.state === 'SUCCESS';
  const checks = { failing: 0, pending: 0, passing: 0 };
  for (const c of latest.values()) {
    const name = c.name ?? c.context ?? 'check';
    const done = c.__typename === 'CheckRun' ? c.status === 'COMPLETED' : c.state !== 'PENDING' && c.state !== 'EXPECTED';
    const bad = !allGreen && FAILED.has(c.conclusion ?? c.state ?? '');
    if (!done) checks.pending++;
    else if (bad) {
      checks.failing++;
      items.push({ kind: 'check', title: name, url: c.detailsUrl ?? c.targetUrl });
    } else checks.passing++;
  }

  let bugs = 0;
  let comments = 0;
  for (const t of pr.reviewThreads?.nodes ?? []) {
    if (t.isResolved || t.isOutdated) continue;
    const c = t.comments?.nodes?.[0];
    if (!c) continue;
    const bot = c.author?.__typename === 'Bot' || /\bbot\b|\[bot\]$/i.test(c.author?.login ?? '');
    bot ? bugs++ : comments++;
    const body = tidy(c.body ?? '');
    items.push({ kind: bot ? 'bug' : 'comment', title: firstLine(body, 'Review comment'), body: clip(body, 1500), path: t.path, line: t.line ?? undefined, url: c.url, who: c.author?.login });
  }
  // Comments on the PR itself (not on a line) from people, since the last push. Bots' status posts
  // (deploy previews and the like) are left out; your own comments too.
  const since = last?.committedDate ? Date.parse(last.committedDate) : 0;
  for (const c of pr.comments?.nodes ?? []) {
    if (c.author?.__typename === 'Bot' || c.author?.login === pr.author?.login || Date.parse(c.createdAt) <= since) continue;
    comments++;
    const body = tidy(c.body ?? '');
    items.push({ kind: 'comment', title: firstLine(body, 'Comment'), body: clip(body, 1500), url: c.url, who: c.author?.login });
  }
  const conflicts = pr.mergeable === 'CONFLICTING';
  const changesRequested = pr.reviewDecision === 'CHANGES_REQUESTED';
  if (conflicts) items.unshift({ kind: 'conflict', title: 'Merge conflicts with the base branch' });
  if (changesRequested) items.unshift({ kind: 'changes', title: 'A reviewer asked for changes' });

  return {
    url: pr.url,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    draft: pr.isDraft,
    checks,
    bugs,
    comments,
    conflicts,
    changesRequested,
    items: items.slice(0, 40),
    checkedAt: Date.now(),
  };
}

const busy = new Set<string>();
/** Read the branch's PR again now. */
export async function refreshPr(branchId: string) {
  const b = getBranch(branchId);
  if (!b?.pr || busy.has(branchId)) return b?.pr;
  if (!(await haveGh())) {
    // Say so instead of quietly showing what was read last time.
    b.pr = { ...b.pr, error: 'The GitHub CLI is not signed in here. Run "gh auth login", then Check now.' };
    push(b);
    return b.pr;
  }
  busy.add(branchId);
  try {
    b.pr = await readPr(b.pr.url, b.cwd);
  } catch (e: any) {
    // Keep when it was last read right, so the panel doesn't claim a fresh read.
    b.pr = { ...b.pr, error: clip(String(e?.stderr || e?.message || e).trim(), 200) };
  } finally {
    busy.delete(branchId);
  }
  save();
  push(b);
  return b.pr;
}

/** Attach a pull request to a branch (or detach with null), then read it. */
export async function linkPr(branchId: string, url: string | null) {
  const b = getBranch(branchId);
  if (!b) throw new Error('Branch not found');
  if (!url) {
    b.pr = undefined;
    save();
    push(b);
    return;
  }
  const ref = parsePrUrl(url);
  if (!ref) throw new Error('Paste a link like https://github.com/owner/repo/pull/12');
  if (!(await haveGh())) throw new Error('Install the GitHub CLI (gh) and run "gh auth login" so Forkspace can read pull requests.');
  b.pr = { url: ref.url, number: ref.number };
  push(b);
  return refreshPr(branchId);
}

/** After a step: if the agent opened or mentioned a pull request, link it to the branch. */
export function prAfterStep(node: TurnNode) {
  const b = getBranch(node.branchId);
  if (!b) return;
  let found: string | undefined;
  // Only from the agent opening or viewing a PR itself: a link it merely read (a changelog, an
  // issue) must not get attached to this branch.
  for (const e of node.events) {
    if (e.t !== 'tool' || e.name !== 'Bash' || e.isError) continue;
    if (!/\bgh\s+pr\s+(create|view|ready|edit)\b/.test(String((e.input as any)?.command ?? ''))) continue;
    const ref = parsePrUrl(typeof e.result === 'string' ? e.result : '');
    if (ref) found = ref.url; // the last one wins
  }
  if (found && found !== b.pr?.url) void linkPr(b.id, found).catch(() => {});
  else if (b.pr && b.pr.state !== 'MERGED' && b.pr.state !== 'CLOSED') void refreshPr(b.id);
}

const lastFind = new Map<string, number>();
const recent = (branchId: string) => {
  const cut = Date.now() - QUIET_DAYS * 86_400_000;
  return state.nodes.some((n) => n.kind === 'turn' && n.branchId === branchId && (n.finishedAt ?? n.createdAt) > cut);
};

/** A worktree branch with no PR yet: is there an open one for its git branch? */
async function find(b: Branch) {
  if (!b.worktree || Date.now() - (lastFind.get(b.id) ?? 0) < FIND_MS) return;
  lastFind.set(b.id, Date.now());
  const head = await g.git(b.cwd, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '');
  if (!head || head === 'HEAD') return;
  const out = await gh(b.cwd, 'pr', 'list', '--head', head, '--state', 'open', '--limit', '1', '--json', 'url').catch(() => '[]');
  const url = JSON.parse(out || '[]')?.[0]?.url;
  if (url) await linkPr(b.id, url).catch(() => {});
}

let polling = false;
async function poll() {
  if (polling || !(await haveGh())) return;
  polling = true;
  try {
    for (const b of [...state.branches]) {
      if (!recent(b.id) && !b.pr) continue;
      if (!b.pr) await find(b).catch(() => {});
      else if (b.pr.state !== 'MERGED' && b.pr.state !== 'CLOSED') await refreshPr(b.id);
    }
  } finally {
    polling = false;
  }
}

export function startPrWatch() {
  setTimeout(() => void poll(), 5_000).unref();
  setInterval(() => void poll(), POLL_MS).unref();
}
