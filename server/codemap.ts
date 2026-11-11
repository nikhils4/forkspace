import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import type { Board, CodeMap, MapAnswer, MapField, MapTrace, MapZoom } from '../shared/types.ts';
import * as g from './git.ts';
import { HOME } from './store.ts';

// A map of the project: what the screens are, which API routes exist, what logic and data sit
// behind them, and what calls what. Claude reads the code (read-only) to draw it, then answers
// questions about it, pointing at the parts of the map that matter.

const DIR = path.join(HOME, 'maps');
fs.mkdirSync(DIR, { recursive: true });
const MODEL = process.env.FORKSPACE_MAP_MODEL || 'sonnet';
const READ_ONLY = ['Read', 'Grep', 'Glob'];

type Progress = (text: string) => void;
const file = (boardId: string) => path.join(DIR, `${boardId.replace(/[^\w-]/g, '')}.json`);

export function loadMap(boardId: string): CodeMap | null {
  try {
    return JSON.parse(fs.readFileSync(file(boardId), 'utf8')) as CodeMap;
  } catch {
    return null;
  }
}

/** Has the code moved on since the map was drawn? */
export async function mapIsStale(board: Board, map: CodeMap) {
  if (!board.repoRoot || !map.commit) return false;
  const head = await g.git(board.cwd, 'rev-parse', 'HEAD').catch(() => '');
  return !!head && head !== map.commit;
}

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What this project is and how it is built, in 2 plain sentences.' },
    layers: {
      type: 'array',
      maxItems: 9,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string', description: 'Short plain name, like "Storefront pages" or "Orders API".' },
          kind: { type: 'string', enum: ['screens', 'api', 'logic', 'data', 'jobs', 'infra', 'shared'] },
          summary: { type: 'string', description: 'One sentence.' },
        },
        required: ['id', 'name', 'kind', 'summary'],
      },
    },
    items: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          layer: { type: 'string', description: 'id of its layer' },
          name: { type: 'string', description: 'Short name, like "Checkout page", "POST /api/orders", "Order model".' },
          kind: { type: 'string', enum: ['page', 'component', 'endpoint', 'service', 'model', 'job', 'config', 'module'] },
          path: { type: 'string', description: 'File path relative to the project root.' },
          line: { type: 'number' },
          route: { type: 'string', description: 'URL or route if it has one, like "/checkout" or "GET /api/orders/:id".' },
          summary: { type: 'string', description: 'What it does, in one plain sentence.' },
          fields: {
            type: 'array',
            maxItems: 30,
            description: 'Only for data models and database tables: their fields, as in the code.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, type: { type: 'string', description: 'Short, like "string", "number", "ref → User", "Item[]".' }, note: { type: 'string', description: 'A few words if the name is unclear.' } },
              required: ['name'],
            },
          },
        },
        required: ['id', 'layer', 'name', 'kind', 'path', 'summary'],
      },
    },
    links: {
      type: 'array',
      maxItems: 160,
      items: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string', description: 'A verb or two, like "calls", "reads", "renders".' } },
        required: ['from', 'to'],
      },
    },
    flows: {
      type: 'array',
      maxItems: 6,
      description: 'The main things that happen in this app, worth walking through.',
      items: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Two or three words, like "Checkout" or "Sign up".' }, question: { type: 'string', description: 'Like "What happens when someone checks out?"' } },
        required: ['name', 'question'],
      },
    },
  },
  required: ['summary', 'layers', 'items', 'links'],
};

/** Cheap facts first, so Claude spends its reading on what matters. */
async function facts(root: string) {
  const files = (await g.git(root, '-c', 'core.quotepath=off', 'ls-files').catch(() => '')).split('\n').filter(Boolean);
  const dirs = new Map<string, number>();
  for (const f of files) {
    const parts = f.split('/');
    const d = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length > 1 ? parts[0] : '.';
    dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  const routeFiles = files.filter((f) => /(^|\/)(app|pages|routes|api|controllers|handlers)\//.test(f) && /\.(tsx?|jsx?|py|rb|go|php)$/.test(f)).slice(0, 220);
  const routeCalls = await g
    .git(root, 'grep', '-n', '-I', '-E', `(app|router|server|api)\\.(get|post|put|patch|delete|use)\\(\\s*['"\`]/`, '--', ':!*.min.js', ':!node_modules')
    .catch(() => '');
  const pkgs = files.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes('node_modules')).slice(0, 6);
  const pkgInfo = pkgs
    .map((p) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
        return `${p}: deps ${Object.keys({ ...j.dependencies }).slice(0, 40).join(', ')}`;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
  let notes = '';
  for (const n of ['CLAUDE.md', 'AGENTS.md', 'README.md']) {
    try {
      notes += `\n--- ${n} ---\n${fs.readFileSync(path.join(root, n), 'utf8').slice(0, 3500)}`;
    } catch {}
  }
  return [
    `${files.length} files tracked.`,
    `Folders (file counts): ${[...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([d, n]) => `${d} (${n})`).join(', ')}`,
    pkgInfo.length ? `Packages:\n${pkgInfo.join('\n')}` : '',
    routeFiles.length ? `Route-like files:\n${routeFiles.join('\n')}` : '',
    routeCalls ? `Route registrations found by grep:\n${routeCalls.split('\n').slice(0, 160).join('\n')}` : '',
    notes,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Run a read-only Claude session that ends in structured output, reporting what it reads. */
async function readOnly<T>(prompt: string, system: string, schema: object, cwd: string, onProgress: Progress, maxTurns: number): Promise<T> {
  const q = query({
    prompt,
    options: {
      model: MODEL,
      cwd,
      tools: READ_ONLY,
      allowedTools: READ_ONLY,
      settingSources: [],
      persistSession: false,
      maxTurns,
      systemPrompt: system,
      outputFormat: { type: 'json_schema', schema: schema as Record<string, unknown> },
      canUseTool: async (name) => (READ_ONLY.includes(name) ? { behavior: 'allow', updatedInput: undefined as any } : { behavior: 'deny', message: 'Read-only: only Read, Grep and Glob.' }),
    },
  });
  let out: T | null = null;
  let err = '';
  for await (const msg of q as AsyncIterable<any>) {
    if (msg.type === 'assistant')
      for (const b of msg.message?.content ?? []) {
        if (b.type !== 'tool_use') continue;
        const i = b.input ?? {};
        const what = i.file_path ? path.relative(cwd, String(i.file_path)) : i.pattern ? `“${String(i.pattern).slice(0, 40)}”` : '';
        onProgress(b.name === 'Read' ? `Reading ${what}` : b.name === 'Grep' ? `Searching for ${what}` : `Looking for ${what}`);
      }
    if (msg.type === 'result') {
      if (msg.subtype === 'success') out = (msg.structured_output as T) ?? null;
      else err = msg.subtype;
    }
  }
  if (!out) throw new Error(err === 'error_max_turns' ? 'It took too long to read everything. Try again.' : 'Could not read the project.');
  return out;
}

const building = new Map<string, Promise<CodeMap>>();

export function buildMap(board: Board, onProgress: Progress): Promise<CodeMap> {
  const running = building.get(board.id);
  if (running) return running;
  const p = (async () => {
    const root = board.cwd;
    onProgress('Listing files');
    const f = await facts(root);
    onProgress('Reading the code');
    const raw = await readOnly<Omit<CodeMap, 'builtAt' | 'commit'>>(
      `Draw a map of this project for a developer who is new to it.\n\n` +
        `Facts gathered so far:\n${f}\n\n` +
        `Read the important files (entry points, routes, main components, services, data models) to understand how it fits together. Don't read everything: sample enough to be accurate.\n\n` +
        `Then return:\n` +
        `- layers: the big parts, each a kind: screens (pages and UI), api (routes and endpoints), logic (services, business rules), data (models, database, storage), jobs (scheduled or background work), infra (config, deploy), shared (utilities used everywhere).\n` +
        `- items: the parts worth knowing, 25 to 90 of them, most important first. Every page and every API route if there are not too many; the main components, services and models. Real file paths only.\n` +
        `- links: what uses what (a page calls an endpoint, an endpoint uses a service, a service reads a model). Only links you saw in the code.\n` +
        `- Data: one item per main database table, collection or model (kind "model"), up to 20, never grouped ("Order", not "Order and payment models"). Every model item must list its fields from the schema or model file. Links between models for their relations (label like "has many", "belongs to").\n` +
        `- flows: 3 to 6 main things that happen in the app (like checkout, sign up, a nightly job), as questions to walk through.\n` +
        `Use plain names a newcomer would understand. ids: short lowercase slugs, unique.`,
      'You map codebases accurately. You only report what is in the code.',
      MAP_SCHEMA,
      root,
      onProgress,
      60,
    );
    const ids = new Set(raw.items.map((i) => i.id));
    const layers = new Set(raw.layers.map((l) => l.id));
    const map: CodeMap = {
      summary: raw.summary,
      layers: raw.layers,
      items: raw.items.filter((i) => layers.has(i.layer) && i.path).map((i) => ({ ...i, path: i.path.replace(/^\.?\//, '') })),
      links: raw.links.filter((l) => ids.has(l.from) && ids.has(l.to) && l.from !== l.to),
      flows: (raw.flows ?? []).slice(0, 6),
      builtAt: Date.now(),
      commit: board.repoRoot ? await g.git(root, 'rev-parse', 'HEAD').catch(() => undefined) : undefined,
    };
    fs.writeFileSync(file(board.id), JSON.stringify(map), { mode: 0o600 });
    return map;
  })().finally(() => building.delete(board.id));
  building.set(board.id, p);
  return p;
}

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: 'The answer, in plain words with markdown. Name files as `path:line`. Short: a few sentences or a short list.' },
    focus: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'ids of map items the answer is about, in the order the reader should look at them.' },
    trace: {
      type: 'object',
      description: 'Only when the question is about something that happens (a user action, a request, a job): the path it takes through the code, step by step.',
      properties: {
        title: { type: 'string', description: 'Like "Checking out a cart of 2 items".' },
        input: { type: 'string', description: 'The data it starts with, as valid JSON text: a small, realistic made-up example in the exact shape the code expects.' },
        steps: {
          type: 'array',
          maxItems: 14,
          items: {
            type: 'object',
            properties: {
              item: { type: 'string', description: 'id of the map item this happens in, if one fits.' },
              path: { type: 'string', description: 'File path relative to the project root.' },
              line: { type: 'number' },
              fn: { type: 'string', description: 'The function, handler or component, like "createOrder()".' },
              does: { type: 'string', description: 'What happens here, in one or two plain sentences with the real details, like "Checks each line is in stock and holds the quantity for 15 minutes."' },
              data: { type: 'string', description: 'The data as it stands after this step, as valid JSON text, continuing the same example: the object this step changes or produces (the checked request, the saved record with its new id and status, the response). Give it at most steps. Keep it small: only the fields that matter here.' },
              tables: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { name: { type: 'string', description: 'Table, collection or model name.' }, op: { type: 'string', enum: ['read', 'create', 'update', 'delete'] }, what: { type: 'string', description: 'A few words, like "stock -1 per line".' } },
                  required: ['name', 'op'],
                },
              },
            },
            required: ['path', 'does'],
          },
        },
      },
      required: ['title', 'steps'],
    },
  },
  required: ['answer', 'focus'],
};

export async function askMap(board: Board, map: CodeMap, question: string, onProgress: Progress): Promise<MapAnswer> {
  const compact = {
    summary: map.summary,
    layers: map.layers.map((l) => `${l.id}: ${l.name} (${l.kind})`),
    items: map.items.map((i) => `${i.id} [${i.kind}] ${i.name}${i.route ? ` ${i.route}` : ''} — ${i.path}${i.line ? `:${i.line}` : ''} — ${i.summary}`),
    links: map.links.map((l) => `${l.from} ${l.label ?? '→'} ${l.to}`),
  };
  const res = await readOnly<{ answer: string; focus: string[]; trace?: MapTrace }>(
    `A developer is exploring this project with a map of it:\n${JSON.stringify(compact)}\n\n` +
      `Their question: "${question.slice(0, 1500)}"\n\n` +
      `Answer it. Use the map to know where to look, and read the actual code to be sure. Point to the map items involved (focus).\n\n` +
      `If the question is about something that happens (someone checks out, a request comes in, a job runs), also give a trace: follow it through the real code from start to finish. ` +
      `Start with a small realistic example of the data that comes in, then each stop: the file, line and function, what it does in plain words with the real details (checks, rules, numbers), ` +
      `how the example data looks after it (most steps should show it, so the reader sees it change: ids appear, statuses move, totals get worked out), and which database tables it reads or changes. Keep the answer itself to 2 or 3 sentences when there is a trace.`,
    'You explain codebases clearly and accurately, in plain words, for someone new to the project. Sample data is made up but always matches the real shapes in the code.',
    ANSWER_SCHEMA,
    board.cwd,
    onProgress,
    40,
  );
  const ids = new Set(map.items.map((i) => i.id));
  const trace = res.trace?.steps?.length
    ? {
        title: res.trace.title,
        input: res.trace.input,
        steps: res.trace.steps.slice(0, 14).map((s) => ({ ...s, path: String(s.path ?? '').replace(/^\.?\//, ''), item: s.item && ids.has(s.item) ? s.item : undefined })),
      }
    : undefined;
  const a: MapAnswer = { question, answer: res.answer, focus: (res.focus ?? []).filter((id) => ids.has(id)), trace, at: Date.now() };
  saveAnswers(board.id, [a, ...loadAnswers(board.id)].slice(0, 30));
  return a;
}

// ---- answers are kept, so walkthroughs are there next time ----
const answersFile = (boardId: string) => file(boardId).replace(/\.json$/, '.answers.json');
export function loadAnswers(boardId: string): MapAnswer[] {
  try {
    return JSON.parse(fs.readFileSync(answersFile(boardId), 'utf8')) as MapAnswer[];
  } catch {
    return [];
  }
}
function saveAnswers(boardId: string, list: MapAnswer[]) {
  fs.writeFileSync(answersFile(boardId), JSON.stringify(list), { mode: 0o600 });
}
export function forgetAnswer(boardId: string, at: number) {
  saveAnswers(boardId, loadAnswers(boardId).filter((a) => a.at !== at));
}

// ---- open up one item: its files and the functions inside ----
const ZOOM_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', maxItems: 8, items: { type: 'object', properties: { path: { type: 'string' }, summary: { type: 'string', description: 'One short sentence.' } }, required: ['path', 'summary'] } },
    parts: {
      type: 'array',
      maxItems: 14,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Like "createOrder()" or "<CartLine>".' },
          kind: { type: 'string', enum: ['function', 'component', 'handler', 'hook', 'query', 'type', 'class', 'method', 'constant'] },
          path: { type: 'string' },
          line: { type: 'number' },
          summary: { type: 'string', description: 'What it does, in one short plain sentence.' },
          uses: { type: 'array', items: { type: 'string' }, description: 'ids of other map items it calls or reads.' },
        },
        required: ['name', 'kind', 'path', 'summary'],
      },
    },
    fields: {
      type: 'array',
      maxItems: 40,
      description: 'Only if this is a data model or table: its fields.',
      items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, note: { type: 'string' } }, required: ['name'] },
    },
  },
  required: ['files', 'parts'],
};
const zooming = new Map<string, Promise<MapZoom>>();

export function zoomItem(board: Board, itemId: string, onProgress: Progress): Promise<MapZoom> {
  const key = `${board.id}:${itemId}`;
  const running = zooming.get(key);
  if (running) return running;
  const p = (async () => {
    const map = loadMap(board.id);
    const it = map?.items.find((i) => i.id === itemId);
    if (!map || !it) throw new Error('That part is not on the map any more.');
    const others = map.items.filter((i) => i.id !== itemId).map((i) => `${i.id}: ${i.name} — ${i.path}`);
    const raw = await readOnly<Omit<MapZoom, 'at'> & { fields?: MapField[] }>(
      `Open up this part of the project for a developer new to it:\n${it.name} (${it.kind}) — ${it.path}${it.line ? `:${it.line}` : ''} — ${it.summary}\n\n` +
        `Read its file (and any small files that belong to it). Return:\n` +
        `- files: the files that make it up, main one first.\n` +
        `- parts: the functions, handlers, components or types inside worth knowing, in the order they run or matter, 3 to 12. Real names and lines. For each, which other map items it uses.\n` +
        `- fields: if it is a data model or table, its fields.\n\n` +
        `Other map items, for "uses":\n${others.join('\n')}`,
      'You map codebases accurately. You only report what is in the code.',
      ZOOM_SCHEMA,
      board.cwd,
      onProgress,
      12,
    );
    const ids = new Set(map.items.map((i) => i.id));
    const clean = (p: string) => String(p ?? '').replace(/^\.?\//, '');
    const zoom: MapZoom = {
      files: (raw.files ?? []).map((f) => ({ ...f, path: clean(f.path) })).slice(0, 8),
      parts: (raw.parts ?? []).slice(0, 14).map((x) => ({ ...x, path: clean(x.path) || it.path, uses: (x.uses ?? []).filter((u) => ids.has(u) && u !== itemId) })),
      at: Date.now(),
    };
    // Save into the latest map on disk (it may have changed while reading).
    const now = loadMap(board.id);
    if (now && now.items.some((i) => i.id === itemId)) {
      now.zoom = { ...now.zoom, [itemId]: zoom };
      const fields = (raw.fields ?? []).filter((f) => f?.name).slice(0, 40);
      const mine = now.items.find((i) => i.id === itemId)!;
      if (fields.length && !mine.fields?.length) mine.fields = zoom.fields = fields;
      fs.writeFileSync(file(board.id), JSON.stringify(now), { mode: 0o600 });
    }
    return zoom;
  })().finally(() => zooming.delete(key));
  zooming.set(key, p);
  return p;
}
