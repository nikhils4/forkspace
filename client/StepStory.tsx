import { useState } from 'react';
import type { TurnEvent, TurnNode } from '../shared/types.ts';
import { Icon } from './icons.tsx';
import { Md, ToolLine } from './nodes.tsx';
import { RunButton } from './RunBox.tsx';
import { ToolDiff, editsOf } from './ToolDiff.tsx';
import { isLive } from './tree.ts';

// A step told as a story: where it landed, where it's heading (its plan), and how it thought its
// way there. The tools it used shrink to one quiet line between thoughts; open it for the detail.

type Tool = Extract<TurnEvent, { t: 'tool' }>;
type Beat = { k: 'say'; text: string; partial?: boolean } | { k: 'think'; text: string } | { k: 'tools'; list: Tool[] } | { k: 'plan' };

/** The latest plan it wrote (TodoWrite), if any. */
export function planOf(node: TurnNode) {
  const last = [...node.events].reverse().find((e): e is Tool => e.t === 'tool' && e.name === 'TodoWrite');
  const todos = (last?.input as any)?.todos;
  if (!Array.isArray(todos) || !todos.length) return null;
  return todos.map((t: any) => ({ text: String(t.content ?? t.activeForm ?? ''), status: String(t.status ?? 'pending'), now: String(t.activeForm ?? t.content ?? '') }));
}

function beatsOf(node: TurnNode) {
  const out: Beat[] = [];
  const lastPlan = node.events.findLastIndex((e) => e.t === 'tool' && e.name === 'TodoWrite');
  node.events.forEach((e, i) => {
    if (e.t === 'text') {
      if (e.text.trim()) out.push({ k: 'say', text: e.text, partial: e.partial });
    } else if (e.t === 'thinking') {
      if (e.text.trim()) out.push({ k: 'think', text: e.text });
    } else if (e.name === 'TodoWrite') {
      if (i === lastPlan) out.push({ k: 'plan' });
    } else {
      const prev = out.at(-1);
      if (prev?.k === 'tools') prev.list.push(e);
      else out.push({ k: 'tools', list: [e] });
    }
  });
  return out;
}

const KIND: Record<string, [string, string]> = {
  Read: ['Read', 'file'],
  Grep: ['Searched', 'time'],
  Glob: ['Searched', 'time'],
  Bash: ['Ran', 'command'],
  Edit: ['Edited', 'file'],
  MultiEdit: ['Edited', 'file'],
  Write: ['Wrote', 'file'],
  NotebookEdit: ['Edited', 'file'],
  WebFetch: ['Read', 'page'],
  WebSearch: ['Searched the web', 'time'],
};
function toolSummary(list: Tool[]) {
  const counts = new Map<string, { verb: string; noun: string; n: number }>();
  for (const e of list) {
    const [verb, noun] = KIND[e.name] ?? ['Used', 'tool'];
    const key = `${verb}|${noun}`;
    const c = counts.get(key) ?? { verb, noun, n: 0 };
    c.n++;
    counts.set(key, c);
  }
  return [...counts.values()].map((c) => (c.noun === 'time' ? (c.n === 1 ? c.verb : `${c.verb} ${c.n} times`) : `${c.verb} ${c.n} ${c.noun}${c.n === 1 ? '' : 's'}`)).join(' · ');
}

function Tools({ list, cwd, live }: { list: Tool[]; cwd?: string; live: boolean }) {
  const failed = list.filter((e) => e.isError).length;
  const going = live && list.some((e) => e.result == null);
  return (
    <details className={`sy-tools ${failed ? 'fail' : ''}`}>
      <summary>
        <span className="sy-tools-mark">{going ? <span className="spinner" /> : failed ? <Icon name="x" size={10} /> : <Icon name="check" size={10} />}</span>
        <span className="sy-tools-sum">{toolSummary(list)}</span>
        {failed > 0 && <span className="sy-tools-fail">{failed} failed</span>}
        <Icon name="chevronRight" size={11} className="fr-caret" />
      </summary>
      <div className="sy-tools-list">
        {list.map((e) => {
          const cmd = e.name === 'Bash' ? String((e.input as any)?.command ?? '') : '';
          return (
            <details key={e.id} className="sy-tool" open={!!e.isError}>
              <summary>
                <ToolLine e={e} cwd={cwd} />
                {cmd.trim() && <RunButton cmd={cmd} className="sv-run" />}
              </summary>
              {editsOf(e) ? <ToolDiff e={e} cwd={cwd} /> : cmd ? null : <pre className="pre">{JSON.stringify(e.input, null, 2)}</pre>}
              {cmd && <pre className="pre">{cmd}</pre>}
              {e.result != null && <pre className={`pre ${e.isError ? 'err' : ''}`}>{e.result.slice(-4000)}</pre>}
            </details>
          );
        })}
      </div>
    </details>
  );
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420;
  return (
    <div className={`sy-think ${long && !open ? 'clamp' : ''}`}>
      <div className="sy-think-text">{text}</div>
      {long && (
        <button className="sy-more" onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}

export function Plan({ node }: { node: TurnNode }) {
  const plan = planOf(node);
  if (!plan) return null;
  const done = plan.filter((t) => t.status === 'completed').length;
  return (
    <section className="sy-sec">
      <h3>
        Plan <span>{done} of {plan.length} done</span>
      </h3>
      <ol className="sy-plan">
        {plan.map((t, i) => (
          <li key={i} className={`p-${t.status}`}>
            <span className="sy-plan-mark">{t.status === 'completed' ? <Icon name="check" size={10} /> : t.status === 'in_progress' ? <span className="sy-plan-now" /> : null}</span>
            <span>{t.status === 'in_progress' ? t.now : t.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The step as Claude sent it, in order: its messages and thinking in full, its plan where it wrote
 * it, and the tools it used as one quiet line between them. */
export function StepStory({ node, cwd }: { node: TurnNode; cwd?: string }) {
  const live = isLive(node);
  const beats = beatsOf(node);
  return (
    <div className="sy-flow">
      {beats.map((b, i) =>
        b.k === 'say' ? (
          <div key={i} className="sy-say">
            <Md text={b.text} partial={b.partial} />
          </div>
        ) : b.k === 'think' ? (
          <Thought key={i} text={b.text} />
        ) : b.k === 'plan' ? (
          <Plan key={i} node={node} />
        ) : (
          <Tools key={i} list={b.list} cwd={cwd} live={live} />
        ),
      )}
      {!beats.length && <div className="ss-quiet">{live ? 'Getting started…' : 'Finished without a message.'}</div>}
      {node.error && <div className="error-box">{node.error}</div>}
    </div>
  );
}
