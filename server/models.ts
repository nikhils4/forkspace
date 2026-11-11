import { query } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os';
import type { ModelChoice } from '../shared/types.ts';

// The models your Claude account can use, straight from Claude Code (the same list its /model
// shows), so new ones appear here without a Forkspace update. Asking is free: no prompt is sent.
// Kept for an hour; if it ever can't be read, a short built-in list stands in.

const FALLBACK: ModelChoice[] = [
  { value: 'default', name: 'Default (recommended)', description: 'Your Claude Code setting' },
  { value: 'opus', name: 'Opus', description: 'For complex work and everyday tasks' },
  { value: 'sonnet', name: 'Sonnet', description: 'Most efficient for simpler tasks' },
  { value: 'haiku', name: 'Haiku', description: 'Fastest for quick answers' },
];

let cache: { at: number; list: ModelChoice[] } | null = null;
let pending: Promise<ModelChoice[]> | null = null;

export function listModels(): Promise<ModelChoice[]> {
  if (cache && Date.now() - cache.at < 60 * 60_000) return Promise.resolve(cache.list);
  return (pending ??= read().finally(() => (pending = null)));
}

async function read(): Promise<ModelChoice[]> {
  const abort = new AbortController();
  // Never sends anything: the session only starts so it can be asked which models exist.
  async function* nothing() {
    await new Promise(() => {});
  }
  try {
    const q = query({ prompt: nothing() as any, options: { cwd: os.homedir(), settingSources: [], persistSession: false, abortController: abort } });
    const models = await Promise.race([q.supportedModels(), new Promise<never>((_, no) => setTimeout(() => no(new Error('timed out')), 20_000))]);
    const list = models.map((m) => ({ value: m.value, name: m.displayName, description: m.description, resolved: m.resolvedModel }));
    if (list.length) cache = { at: Date.now(), list };
    return list.length ? list : FALLBACK;
  } catch {
    return FALLBACK;
  } finally {
    abort.abort();
  }
}
