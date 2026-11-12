import { createContext, useContext, type ReactNode } from 'react';

// Markdown for agent replies, summaries and concepts: headings, lists (nested, numbered, tasks),
// tables, quotes, rules, code, links. Built as React elements, never raw HTML, so nothing an
// agent writes can run in the page. Code blocks are rendered by the caller (copy button etc.).

type CodeRender = (code: string, lang: string, key: number) => ReactNode;

const SAFE_URL = /^(https?:|mailto:)/i;

/** Where a `path:line` in the text should open. Without one, code stays plain. */
export const CodeRefCtx = createContext<((path: string, line?: number) => void) | null>(null);
const REF = /^([\w@~.\/-]*[\w-]\.[a-zA-Z0-9]{1,6})(?::(\d+)(?:-\d+)?)?$/;

function Code({ text }: { text: string }) {
  const open = useContext(CodeRefCtx);
  const m = open ? text.match(REF) : null;
  if (!open || !m || !m[1].includes('/') && !m[2]) return <code>{text}</code>;
  return (
    <code
      className="code-ref"
      role="link"
      tabIndex={0}
      title={`Open ${m[1]}${m[2] ? ` at line ${m[2]}` : ''}`}
      onClick={(e) => (e.stopPropagation(), open(m[1], m[2] ? Number(m[2]) : undefined))}
      onKeyDown={(e) => e.key === 'Enter' && open(m[1], m[2] ? Number(m[2]) : undefined)}
    >
      {text}
    </code>
  );
}

/** Inline: `code`, **bold**, *italic*, ~~strike~~, [links](url) and bare URLs. */
export function inline(s: string, keyBase = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let k = keyBase;
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|((?<![\w*])\*[^*\s][^*\n]*?\*(?![\w*]))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(<Code key={k++} text={t.slice(1, -1)} />);
    else if (m[2]) out.push(<b key={k++}>{inline(t.slice(2, -2), k * 100)}</b>);
    else if (m[3]) out.push(<s key={k++}>{inline(t.slice(2, -2), k * 100)}</s>);
    else if (m[4]) {
      const lm = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      out.push(
        SAFE_URL.test(lm[2]) ? (
          <a key={k++} href={lm[2]} target="_blank" rel="noreferrer noopener">
            {inline(lm[1], k * 100)}
          </a>
        ) : (
          lm[1]
        ),
      );
    } else if (m[5])
      out.push(
        <a key={k++} href={t} target="_blank" rel="noreferrer noopener">
          {t}
        </a>,
      );
    else if (m[6]) out.push(<i key={k++}>{inline(t.slice(1, -1), k * 100)}</i>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(l) || /^\s*\|\s*:?-+:?\s*\|\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
const LIST = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;

interface Item {
  text: string;
  ordered: boolean;
  start: number;
  task?: boolean;
  done?: boolean;
  children: Item[];
  indent: number;
}

function renderList(items: Item[], key: number): ReactNode {
  const ordered = items[0]?.ordered;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag key={key} className={`md-list ${items.some((i) => i.task) ? 'tasks' : ''}`} start={ordered ? items[0].start : undefined}>
      {items.map((it, i) => (
        <li key={i} className={it.task ? `task ${it.done ? 'done' : ''}` : undefined}>
          {it.task && <input type="checkbox" checked={!!it.done} readOnly tabIndex={-1} />}
          <span>{inline(it.text)}</span>
          {it.children.length > 0 && renderList(it.children, 1)}
        </li>
      ))}
    </Tag>
  );
}

export function Markdown({ text, code }: { text: string; code: CodeRender }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const parts: ReactNode[] = [];
    para.forEach((l, j) => {
      if (j) parts.push(<br key={`br${j}`} />);
      parts.push(...inline(l, j * 1000));
    });
    out.push(<p key={out.length}>{parts}</p>);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    // fenced code (an unfinished fence while streaming still shows as code)
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(code(body.join('\n'), fence[2], out.length));
      continue;
    }
    // table: a header row, then a separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(
        <div key={out.length} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((h, c) => (
                  <th key={c} style={{ textAlign: align[c] as any }}>
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, c) => (
                    <td key={c} style={{ textAlign: align[c] as any }}>
                      {inline(r[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // heading
    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flushPara();
      const level = Math.min(4, h[1].length);
      const Tag = `h${level + 1}` as 'h2';
      out.push(
        <Tag key={out.length} className={`md-h md-h${level}`}>
          {inline(h[2])}
        </Tag>,
      );
      i++;
      continue;
    }
    // rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      out.push(<hr key={out.length} className="md-hr" />);
      i++;
      continue;
    }
    // quote
    if (/^\s*>/.test(line)) {
      flushPara();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(
        <blockquote key={out.length} className="md-quote">
          <Markdown text={body.join('\n')} code={code} />
        </blockquote>,
      );
      continue;
    }
    // lists, nested by indent
    if (LIST.test(line)) {
      flushPara();
      const root: Item[] = [];
      const stack: Item[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const lm = l.match(LIST);
        if (!lm) {
          // a wrapped continuation line belongs to the last item
          if (l.trim() && /^\s{2,}/.test(l) && stack.length) {
            stack[stack.length - 1].text += ' ' + l.trim();
            i++;
            continue;
          }
          if (!l.trim() && i + 1 < lines.length && LIST.test(lines[i + 1])) {
            i++;
            continue;
          }
          break;
        }
        const indent = lm[1].replace(/\t/g, '  ').length;
        let body = lm[3];
        const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
        const item: Item = { text: task ? task[2] : body, ordered: /\d/.test(lm[2]), start: parseInt(lm[2], 10) || 1, task: !!task, done: task ? task[1] !== ' ' : undefined, children: [], indent };
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        if (stack.length) stack[stack.length - 1].children.push(item);
        else root.push(item);
        stack.push(item);
        i++;
      }
      out.push(renderList(root, out.length));
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return <>{out}</>;
}
