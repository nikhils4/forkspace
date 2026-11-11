import type { HookCallbackMatcher, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

// Safety nets every agent runs with, on every board, whatever its approval mode (even "approve
// everything"). Three kinds:
//   - never:  refused outright (pushing code anywhere). The agent hands you the command instead.
//   - ask:    paused for your yes or no on the card (commits, AWS and other clouds, databases that
//             aren't on this machine, secrets). A board's "always allow" can't skip these.
//   - rules:  told to the agent up front, so it rarely gets as far as being stopped.

export const SAFETY_RULES = `
# Forkspace safety rules (always on, set by the user)

- Never push. Do not run \`git push\`, \`gh pr create\`, \`gh pr merge\` or anything else that sends code to a remote. When the work is ready, end with the exact commands for the user to run themselves (commit, push, open the PR), filled in with real values.
- Never commit on your own. Do not run \`git commit\`. Leave the changes uncommitted and give the user the exact \`git add\` / \`git commit -m "..."\` commands, with a message that follows the repo's style.
- Never touch AWS or any other cloud account (aws, terraform, cdk, pulumi, kubectl, gcloud, az, vercel, netlify, fly, heroku and the like), and never connect to a production or other remote database, unless the user has explicitly said yes for this task. Ask first and explain what you would run and why. Local databases for development and tests are fine.
- Never read or print secrets (credential files, production .env files, API keys). If you need one, ask the user.
- Forkspace enforces these rules: refused or paused commands are not a bug. Don't try to work around them (aliases, scripts, other tools); give the user the command instead.
`.trim();

type Verdict = { decision: 'deny' | 'ask'; reason: string } | null;

// This machine, or the usual names of a local docker-compose database.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal|db|database|postgres|postgresql|mysql|mariadb|mongo|mongodb|redis)$/i;
const CLOUD_CLIS = ['aws', 'sam', 'cdk', 'cdktf', 'terraform', 'tofu', 'pulumi', 'eksctl', 'kubectl', 'helm', 'gcloud', 'gsutil', 'bq', 'az', 'doctl', 'flyctl', 'fly', 'vercel', 'netlify', 'heroku', 'railway', 'render', 'wrangler', 'sls', 'serverless', 'amplify', 'copilot', 'firebase', 'supabase', 'pscale', 'neonctl', 'turso', 'atlas'];
const DB_CLIS = ['psql', 'pg_dump', 'pg_dumpall', 'pg_restore', 'mysql', 'mysqldump', 'mariadb', 'mongo', 'mongosh', 'mongodump', 'mongorestore', 'redis-cli', 'cqlsh', 'sqlcmd', 'clickhouse-client'];

/** Split a shell line into simple commands, and each into words (good enough for checks, not a full shell parser). */
function commands(line: string): string[][] {
  return line
    .split(/\|\||&&|;|\||\n|\$\(|`|\(|\)/)
    .map((c) => {
      const words = c.trim().split(/\s+/).filter(Boolean);
      // Skip leading env settings (FOO=1), sudo, npx, "yarn run" and friends: look at the real program.
      let i = 0;
      while (i < words.length - 1 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i]) || /^\d+[smh]?$/.test(words[i]))) i++;
      return words.slice(i);
    })
    .filter((c) => c.length);
}
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nice', 'nohup', 'timeout', 'npx', 'bunx', 'pnpx', 'dotenv', 'aws-vault', 'doppler', 'yarn', 'pnpm', 'npm', 'bun', 'run', 'dlx', '--', '-y', '--yes']);
const prog = (w: string) => w.replace(/^.*\//, '').replace(/^["']|["']$/g, '');

function checkBash(line: string): Verdict {
  const text = line.toLowerCase();
  for (const words of commands(line)) {
    const p = prog(words[0]);
    const rest = words.slice(1).map((w) => w.toLowerCase());
    if (p === 'git') {
      // Skip git's own options (-C dir, -c key=val, --git-dir=...) to find the subcommand.
      let i = 0;
      while (i < rest.length && rest[i].startsWith('-')) i += rest[i] === '-c' || rest[i] === '-C' ? 2 : 1;
      const sub = rest[i];
      if (sub === 'push') return { decision: 'deny', reason: 'Safety rule: agents never push. Give the user the exact push command to run instead.' };
      if (sub === 'commit') return { decision: 'ask', reason: 'Safety rule: agents don’t commit on their own. Allow this commit?' };
      if (sub === 'remote' && /\b(add|set-url)\b/.test(rest.join(' '))) return { decision: 'ask', reason: 'Safety rule: changing where this repo pushes to. Allow?' };
    }
    if (p === 'gh') {
      const sub = rest.slice(0, 2).join(' ');
      if (/^(pr (create|merge|ready|close|reopen|edit|comment|review)|release (create|upload|delete|edit)|repo (create|delete|edit|fork|sync|rename|archive)|workflow run|run (rerun|cancel)|secret|variable)/.test(sub))
        return { decision: 'deny', reason: 'Safety rule: agents never push or change GitHub. Give the user the exact gh command to run instead.' };
      if (rest[0] === 'api' && /(-x|--method)\s*(post|put|patch|delete)/.test(text)) return { decision: 'deny', reason: 'Safety rule: agents never change GitHub. Give the user the command instead.' };
    }
    if (CLOUD_CLIS.includes(p)) return { decision: 'ask', reason: `Safety rule: this uses a cloud account (${p}). Allow it this time?` };
    if (DB_CLIS.includes(p)) {
      const host = text.match(/(?:-h|--host)[=\s]+([^\s'"]+)/)?.[1];
      if (!host || !LOCAL_HOST.test(host) || /postgres|mysql|mongodb|redis/.test(text) && remoteUrl(text)) return { decision: 'ask', reason: `Safety rule: this connects to a database (${p}). Allow it this time?` };
    }
    // Migrations and schema pushes against whatever the env points at.
    const joined = [p, ...rest].join(' ');
    if (/\b(prisma (migrate (deploy|reset|resolve)|db (push|execute|seed))|drizzle-kit (push|migrate|drop)|knex migrate|sequelize db:|typeorm (migration:run|schema:(sync|drop))|rails db:|rake db:|alembic (upgrade|downgrade)|flyway|liquibase)\b/.test(joined))
      return { decision: 'ask', reason: 'Safety rule: this changes a database schema or data. Allow it this time?' };
  }
  // Secrets and cloud credentials, however they're read.
  if (/(^|[\s'"=/])(~|\$home|\/users\/[^/\s]+|\/home\/[^/\s]+)\/\.(aws|ssh|kube|docker\/config|config\/gcloud|azure|netrc|pgpass)\b/.test(text) || /\.env\.(prod|production)\b/.test(text))
    return { decision: 'ask', reason: 'Safety rule: this reads credentials or production secrets. Allow it this time?' };
  if (remoteUrl(text)) return { decision: 'ask', reason: 'Safety rule: this connects to a database that isn’t on this machine. Allow it this time?' };
  return null;
}

/** A database URL pointing somewhere other than this machine. */
function remoteUrl(text: string) {
  for (const m of text.matchAll(/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss):\/\/(?:[^@\s/'"]*@)?([^:/?\s'"]+)/g)) if (!LOCAL_HOST.test(m[1])) return true;
  return false;
}

function checkPath(p: string): Verdict {
  if (/(^|\/)\.(aws|ssh|kube|azure|netrc|pgpass)(\/|$)|\/\.config\/gcloud\/|\/\.docker\/config\.json$|(^|\/)\.env\.(prod|production)$/i.test(p))
    return { decision: 'ask', reason: 'Safety rule: this file holds credentials or production secrets. Allow reading it this time?' };
  return null;
}

// Tools from connected services (MCP) that reach clouds or databases.
const RISKY_MCP = /aws|amazon|bedrock|cloudformation|planetscale|supabase|neon|postgres|mysql|mongo|database|\bdb\b|redis|cloudflare|vercel|netlify|heroku|render|railway|gcp|google_cloud|azure|terraform|kubernetes|k8s|stripe/i;

export function check(toolName: string, input: any): Verdict {
  if (toolName === 'Bash') return checkBash(String(input?.command ?? ''));
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return checkPath(String(input?.file_path ?? input?.notebook_path ?? ''));
  if (toolName === 'Grep' || toolName === 'Glob') return checkPath(String(input?.path ?? ''));
  if (toolName.startsWith('mcp__') && RISKY_MCP.test(toolName)) return { decision: 'ask', reason: `Safety rule: this uses a connected cloud or database service (${toolName.split('__')[1]}). Allow it this time?` };
  return null;
}

/** The hook Forkspace attaches to every agent: runs before every tool, in every approval mode. */
export const safetyHooks: Partial<Record<'PreToolUse', HookCallbackMatcher[]>> = {
  PreToolUse: [
    {
      hooks: [
        async (input: any): Promise<HookJSONOutput> => {
          let v: Verdict;
          try {
            v = check(input.tool_name, input.tool_input);
          } catch {
            // If the check itself breaks, ask rather than let it through.
            v = { decision: 'ask', reason: 'Safety check could not read this command. Allow it?' };
          }
          if (!v) return {};
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: v.decision, permissionDecisionReason: v.reason } };
        },
      ],
    },
  ],
};
