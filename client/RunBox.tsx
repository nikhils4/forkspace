import { createContext, useContext, type ReactNode } from 'react';
import { runInTerminal } from './store.ts';

// One shell per task for the Run buttons on commands. Run opens the terminal panel at the bottom and
// runs it in the task's own tab, which starts in the task's folder and stays open, so a `cd` in one
// command carries to the next. Fresh in the panel starts that tab over.

type Shell = { run: (cmd: string) => void };
const ShellCtx = createContext<Shell | null>(null);
export const useTaskRun = () => useContext(ShellCtx)?.run ?? null;

const SHELL_LANGS = new Set(['', 'sh', 'bash', 'zsh', 'shell', 'console', 'terminal', 'fish']);
/** Shell code blocks only. A block with no language counts when it reads like one short command. */
export function runnable(code: string, lang: string) {
  const l = lang.trim().toLowerCase();
  if (!SHELL_LANGS.has(l)) return false;
  if (l) return true;
  const lines = code.trim().split('\n');
  return lines.length <= 3 && /^\$?\s*(npm|npx|yarn|pnpm|bun|node|git|cd|ls|make|cargo|go|python3?|pip|uv|docker|curl|brew|deno|tsc|vite|pytest|bundle|rails|swift|xcodebuild|open|cat|mkdir|rm|cp|mv|chmod|export|source|\.\/)\b/.test(lines[0]);
}
/** Drop prompt marks ("$ npm test") and trailing output-only lines from a pasted session. */
const clean = (cmd: string) => {
  const lines = cmd.replace(/\s+$/, '').split('\n');
  return lines.some((l) => /^\s*\$ /.test(l))
    ? lines
        .filter((l) => /^\s*\$ /.test(l))
        .map((l) => l.replace(/^\s*\$ /, ''))
        .join('\n')
    : lines.join('\n');
};

export function TaskShell({ rootId, branchId, children }: { rootId: string; branchId: string; children: ReactNode }) {
  const run = (raw: string) => {
    const cmd = clean(raw);
    if (cmd.trim()) runInTerminal(branchId, `run:${rootId}`, cmd);
  };
  return <ShellCtx.Provider value={{ run }}>{children}</ShellCtx.Provider>;
}
