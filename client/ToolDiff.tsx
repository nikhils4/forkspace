import type { TurnEvent } from '../shared/types.ts';

// An agent's file edit, shown the way you'd read it in a review: removed lines in red with −,
// added lines in green with +, a few unchanged lines around them. Instead of raw JSON.

type Line = { t: ' ' | '+' | '-'; s: string };
const MAX = 700; // lines per side we diff properly; bigger edits show as removed then added

/** Line diff of two texts (longest common subsequence, after trimming the shared start and end). */
export function lineDiff(before: string, after: string): Line[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((s): Line => ({ t: ' ', s }));
  const tail = a.slice(endA).map((s): Line => ({ t: ' ', s }));
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  let mid: Line[];
  if (x.length > MAX || y.length > MAX) mid = [...x.map((s): Line => ({ t: '-', s })), ...y.map((s): Line => ({ t: '+', s }))];
  else {
    // dp[i][j] = longest common run of x[i..] and y[j..]
    const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    mid = [];
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        mid.push({ t: ' ', s: x[i++] });
        j++;
      } else if (i < x.length && (j >= y.length || dp[i + 1][j] >= dp[i][j + 1])) mid.push({ t: '-', s: x[i++] });
      else mid.push({ t: '+', s: y[j++] });
    }
  }
  return [...head, ...mid, ...tail];
}

/** Keep changed lines plus `ctx` around them; long unchanged runs fold into "⋯ N unchanged lines". */
function fold(lines: Line[], ctx = 3): (Line | { gap: number })[] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.t !== ' ') for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep[k] = true;
  });
  // Folding one or two lines saves nothing: show them.
  for (let i = 0; i < lines.length; ) {
    if (keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep[j]) j++;
    if (j - i < 3) for (let k = i; k < j; k++) keep[k] = true;
    i = j;
  }
  const out: (Line | { gap: number })[] = [];
  let gap = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (gap) out.push({ gap });
      gap = 0;
      out.push(l);
    } else gap++;
  });
  if (gap) out.push({ gap });
  return out;
}

type Tool = Extract<TurnEvent, { t: 'tool' }>;

/** The edits a file tool made, as before/after pairs. Null for tools that don't change files. */
export function editsOf(e: Pick<Tool, 'name' | 'input'>): { path: string; pairs: { before: string; after: string }[]; isNew: boolean } | null {
  const i = (e.input ?? {}) as any;
  const path = String(i.file_path ?? i.notebook_path ?? '');
  if (e.name === 'Edit' && typeof i.old_string === 'string') return { path, pairs: [{ before: i.old_string, after: String(i.new_string ?? '') }], isNew: false };
  if (e.name === 'MultiEdit' && Array.isArray(i.edits)) return { path, pairs: i.edits.map((x: any) => ({ before: String(x.old_string ?? ''), after: String(x.new_string ?? '') })), isNew: false };
  if (e.name === 'Write' && typeof i.content === 'string') return { path, pairs: [{ before: '', after: i.content }], isNew: true };
  return null;
}

/** How many lines an edit adds and removes. */
export function editCounts(e: Pick<Tool, 'name' | 'input'>) {
  const ed = editsOf(e);
  if (!ed) return null;
  let add = 0;
  let del = 0;
  for (const p of ed.pairs)
    for (const l of p.before ? lineDiff(p.before, p.after) : p.after.split('\n').map((s): Line => ({ t: '+', s })))
      if (l.t === '+') add++;
      else if (l.t === '-') del++;
  return { add, del };
}

const WRITE_MAX = 400;

/** A file tool's change as a coloured diff. */
export function ToolDiff({ e, cwd }: { e: Pick<Tool, 'name' | 'input'>; cwd?: string }) {
  const ed = editsOf(e);
  if (!ed) return null;
  const path = cwd ? ed.path.split(cwd + '/').join('') : ed.path;
  const c = editCounts(e)!;
  return (
    <div className="tool-diff">
      {ed.isNew && (
        <div className="td-head">
          <span className="fr-tag">new file</span>
          <span className="ellipsis" title={ed.path}>
            {path}
          </span>
          <span className="add-text">+{c.add}</span>
        </div>
      )}
      {ed.pairs.map((p, n) => {
        const all = p.before ? lineDiff(p.before, p.after) : p.after.split('\n').map((s): Line => ({ t: '+', s }));
        const rows = p.before ? fold(all) : all.slice(0, WRITE_MAX);
        return (
          <pre key={n} className="diff">
            {ed.pairs.length > 1 && <div className="hunk">Edit {n + 1} of {ed.pairs.length}</div>}
            {rows.map((l, i) =>
              'gap' in l ? (
                <div key={i} className="gap">
                  ⋯ {l.gap} unchanged line{l.gap === 1 ? '' : 's'}
                </div>
              ) : (
                <div key={i} className={l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}>
                  <span className="dm">{l.t === ' ' ? ' ' : l.t === '-' ? '−' : '+'}</span>
                  {l.s || ' '}
                </div>
              ),
            )}
            {!p.before && all.length > WRITE_MAX && <div className="gap">⋯ {all.length - WRITE_MAX} more lines</div>}
          </pre>
        );
      })}
    </div>
  );
}
