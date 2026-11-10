import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { WebSocketServer, type WebSocket } from 'ws';
import { conceptKey, type Board, type ClientMsg, type ServerMsg } from '../shared/types.ts';
import { openFolder } from './editor.ts';
import { listFiles, readFile } from './files.ts';
import { importSessions, listImportable } from './importer.ts';
import { applyImport, checkFolder, exportWorkspace, readImport } from './transfer.ts';
import { applyUpdate, checkForUpdate, currentBuild } from './updater.ts';
import { disableService, enableService, serviceStatus, startCommand } from './service.ts';
import * as g from './git.ts';
import { checkToken, getPublicUrl, getToken, isLocalRequest, newPairCode, redeemPairCode, rotateToken, setPublicUrl } from './auth.ts';
import * as push from './push.ts';
import { enableTailscaleServe, tailscaleInfo } from './remote.ts';
import { awayStatus, noteDevice, setAway } from './away.ts';
import { capture, deleteShot, imageType, readShot, saveShot } from './shots.ts';
import { attachTerminal, closeBoardTerminals, closeTerminal, listTerminals, openTerminal, resizeTerminal, setTerminalEmitter, setTerminalRemoteAllowed, terminalRemoteAllowed, terminalSupported, writeTerminal } from './terminal.ts';
import { answer, isRunning, pruneBranches, setActivityHook, setEmitter, setNotifier, startTurn, stop, touch } from './runner.ts';
import { explain, onActivity, organizeConcepts, readImageText, setTutorTouch, threadTitle } from './tutor.ts';
import { flush, getBoard, getBranch, getNode, getTurn, save, state, subtree } from './store.ts';

const PORT = Number(process.env.PORT || 4747);
const HOST = process.env.HOST || '127.0.0.1';
// dist/ sits at the package root; this file runs from server/ (dev) or build/server/ (published).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = [path.resolve(HERE, '../dist'), path.resolve(HERE, '../../dist')].find((d) => fs.existsSync(d)) ?? path.resolve(HERE, '../dist');

// ---- static client ----
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname === '/api/local-token') {
    // Only a browser on this Mac, talking to us directly, may read the key.
    if (!isLocalRequest(req)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"not local"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ token: getToken() }));
    return;
  }
  if (url.pathname === '/api/check') {
    const ok = checkToken((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok }));
    return;
  }
  if (url.pathname === '/api/pair' && req.method === 'POST') {
    // A JSON content type forces a CORS preflight, so random web pages can't spam guesses.
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      res.writeHead(415, { 'content-type': 'application/json' });
      res.end('{"error":"json only"}');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c).length > 1000 && req.destroy());
    req.on('end', () => {
      try {
        const token = redeemPairCode(JSON.parse(body).code);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ token }));
      } catch (err: any) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
    });
    return;
  }
  if (url.pathname.startsWith('/api/workspace/')) return workspaceApi(req, res, url);
  if (url.pathname.startsWith('/api/shots')) return shotsApi(req, res, url);
  let file = path.join(DIST, path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (url.pathname.startsWith('/assets/')) {
      res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end('Not found');
      return;
    }
    file = path.join(DIST, 'index.html');
  }
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Forkspace server is running. Build the client with `npm run build`, or use `npm run dev` and open http://localhost:5173');
    return;
  }
  const ext = path.extname(file);
  const hashed = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    // Hashed bundles never change; everything else (index.html, sw.js, manifest) must revalidate.
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
});

// ---- moving a workspace between machines (files are too big for the socket) ----
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('That file is too big.'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function workspaceApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!checkToken((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return json(401, { error: 'Sign in first.' });
  try {
    const route = url.pathname.slice('/api/workspace/'.length);
    if (route === 'export' && req.method === 'GET') {
      const { file: buf, skipped } = await exportWorkspace();
      const day = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="forkspace-${day}.forkspace"`,
        'content-length': buf.length,
        'x-forkspace-skipped': String(skipped),
        'access-control-expose-headers': 'x-forkspace-skipped',
        'cache-control': 'no-store',
      });
      return res.end(buf);
    }
    if (route === 'import' && req.method === 'POST') return json(200, readImport(await readBody(req, 1024 * 1024 * 1024)));
    if (route === 'folder' && req.method === 'GET') {
      const p = (url.searchParams.get('path') ?? '').replace(/^~(?=$|\/)/, os.homedir());
      return json(200, { exists: checkFolder(p) });
    }
    if (route === 'apply' && req.method === 'POST') {
      const { id, folders } = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const r = await applyImport(String(id), folders ?? {});
      for (const board of r.boards) broadcast({ type: 'board', board });
      for (const branch of r.branches) broadcast({ type: 'branch', branch });
      for (const node of r.nodes) broadcast({ type: 'node', node });
      return json(200, r.results);
    }
    json(404, { error: 'Not found' });
  } catch (err: any) {
    json(400, { error: String(err?.message ?? err) });
  }
}

// ---- screenshots on steps (images are too big for the socket) ----
async function shotsApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!checkToken((req.headers.authorization ?? '').replace(/^Bearer /, ''))) return json(401, { error: 'Sign in first.' });
  try {
    // Notes: "Turn into text" reads an image without keeping it.
    if (req.method === 'POST' && url.pathname === '/api/shots/read') {
      const bytes = await readBody(req, 13 * 1024 * 1024);
      return json(200, { text: await readImageText(bytes, imageType(bytes), os.homedir()) });
    }
    // Notes: "Add image" keeps it in the note.
    if (req.method === 'POST' && url.pathname === '/api/shots' && url.searchParams.get('note')) {
      const note = getNode(url.searchParams.get('note')!);
      if (!note || note.kind !== 'note') return json(404, { error: 'Note not found' });
      const id = saveShot(await readBody(req, 13 * 1024 * 1024));
      note.images = [...(note.images ?? []), id].slice(-12);
      save();
      broadcast({ type: 'node', node: note });
      return json(200, { id });
    }
    if (req.method === 'POST' && url.pathname === '/api/shots') {
      const node = getTurn(url.searchParams.get('node') ?? '');
      if (!node) return json(404, { error: 'Step not found' });
      const id = saveShot(await readBody(req, 13 * 1024 * 1024));
      node.shots = [...(node.shots ?? []), id].slice(-12);
      save();
      broadcast({ type: 'node', node });
      return json(200, { id });
    }
    const id = url.pathname.split('/')[3] ?? '';
    const shot = req.method === 'GET' ? readShot(id) : null;
    if (!shot) return json(404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': shot.type, 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
    res.end(shot.bytes);
  } catch (err: any) {
    json(400, { error: String(err?.message ?? err) });
  }
}

/** Forget the screenshots of steps that are going away. */
const dropShots = (ids: Iterable<string>) => {
  for (const id of ids) {
    const n = getNode(id);
    for (const s of (n?.kind === 'turn' ? n.shots : n?.images) ?? []) deleteShot(s);
  }
};

// ---- websocket ----
// Agents can run commands on this machine, so every connection must carry the access key.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 8 * 1024 * 1024,
  verifyClient: ({ req }: { req: http.IncomingMessage }) => checkToken(new URL(req.url || '/', 'http://x').searchParams.get('t')),
});
const clients = new Set<WebSocket>();
// The http server's errors (like the port being busy) are re-emitted here; without a listener Node would crash.
wss.on('error', () => {});

// Heartbeat: drop sockets that stopped answering (a phone that lost signal), so they can't
// hold "someone is looking" and swallow notifications.
const alive = new Map<WebSocket, number>();
setInterval(() => {
  const now = Date.now();
  for (const c of clients) {
    if (now - (alive.get(c) ?? now) > 60_000) {
      c.terminate();
      continue;
    }
    try {
      c.ping();
    } catch {}
  }
}, 25_000).unref();

function broadcast(msg: ServerMsg) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
}
setEmitter(broadcast);
setTutorTouch(touch);
setActivityHook(onActivity);

const send = (ws: WebSocket, msg: ServerMsg) => ws.send(JSON.stringify(msg));

const visible = new Map<WebSocket, boolean>();
/** Sockets from another device (phone over a tunnel), not this machine. */
const remoteOf = new Map<WebSocket, boolean>();

// Terminal output only goes to screens allowed to use the terminal.
setTerminalEmitter((msg) => {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN && (!remoteOf.get(c) || terminalRemoteAllowed())) c.send(data);
});

// Push to phones/desktops only when nobody is looking at Forkspace right now.
setNotifier((node, kind) => {
  const now = Date.now();
  if ([...visible].some(([c, v]) => v && now - (alive.get(c) ?? 0) < 60_000)) return;
  const board = getBoard(node.boardId);
  const short = node.prompt.replace(/\s+/g, ' ').slice(0, 90);
  const url = `/?board=${node.boardId}&node=${node.id}`;
  if (kind === 'waiting')
    push.notify({ title: `Needs you · ${board?.name ?? 'Forkspace'}`, body: node.pending ? `Allow ${node.pending.toolName}? ${short}` : short, tag: node.id, url });
  else
    push.notify({ title: `${node.status === 'error' ? 'Failed' : 'Done'} · ${board?.name ?? 'Forkspace'}`, body: short, tag: node.id, url });
});

wss.on('connection', (ws, req) => {
  clients.add(ws);
  // Remember when a phone (or any other device) connects, for away mode's setup.
  const deviceId = nanoid(6);
  const remote = !isLocalRequest(req);
  remoteOf.set(ws, remote);
  ws.on('close', () => remoteOf.delete(ws));
  noteDevice(deviceId, remote, String(req.headers['user-agent'] ?? ''), true);
  ws.on('close', () => noteDevice(deviceId, remote, '', false));
  visible.set(ws, false);
  alive.set(ws, Date.now());
  ws.on('pong', () => alive.set(ws, Date.now()));
  ws.on('error', () => ws.terminate());
  ws.on('close', () => {
    visible.delete(ws);
    alive.delete(ws);
  });
  send(ws, { type: 'state', state, home: os.homedir(), build: BUILD, startCommand: startCommand() });
  ws.on('close', () => clients.delete(ws));
  ws.on('message', async (raw) => {
    alive.set(ws, Date.now());
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as any).type !== 'string') return;
    const reqId = 'reqId' in msg ? msg.reqId : undefined;
    try {
      const data = await handle(msg, ws);
      if (reqId) send(ws, { type: 'reply', reqId, ok: true, data });
    } catch (err: any) {
      const error = String(err?.message ?? err);
      if (reqId) send(ws, { type: 'reply', reqId, ok: false, error });
      else send(ws, { type: 'toast', level: 'error', text: error });
    }
  });
});

const MODES = new Set(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);

/** Positions come from clients; never let a bad one into the saved state. */
const goodPos = (p: any): p is { x: number; y: number } => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

const expand = (p: string) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));

async function handle(msg: ClientMsg, currentWs: WebSocket): Promise<unknown> {
  switch (msg.type) {
    case 'createBoard': {
      const cwd = expand(msg.cwd.trim());
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Folder not found: ${cwd}`);
      const root = await g.repoRoot(cwd);
      let isolation = msg.isolation;
      if (isolation === 'worktree') {
        if (!root) throw new Error('Worktree mode needs a git repo. Pick "Same folder" or run `git init` there first.');
        if (!(await g.hasCommits(root))) throw new Error('This repo has no commits yet. Make one commit first, then create the board.');
      }
      const board: Board = {
        id: nanoid(8),
        name: msg.name.trim() || path.basename(cwd),
        cwd,
        repoRoot: root ?? undefined,
        relPath: root ? path.relative(root, cwd) : undefined,
        isolation,
        permissionMode: msg.permissionMode,
        learn: { on: true, level: 'growing' },
        createdAt: Date.now(),
        links: [],
      };
      state.boards.push(board);
      save();
      broadcast({ type: 'board', board });
      return board;
    }
    case 'updateBoard': {
      const board = getBoard(msg.id);
      if (!board) throw new Error('Board not found');
      const p = (msg.patch ?? {}) as Record<string, unknown>;
      if (typeof p.name === 'string' && p.name.trim()) board.name = p.name.trim().slice(0, 80);
      if (typeof p.permissionMode === 'string' && MODES.has(p.permissionMode)) board.permissionMode = p.permissionMode as Board['permissionMode'];
      if ('model' in p) board.model = typeof p.model === 'string' && p.model.trim() ? p.model.trim().slice(0, 80) : undefined;
      if (p.learn && typeof p.learn === 'object') board.learn = { on: (p.learn as any).on !== false, level: (p.learn as any).level ?? 'growing' };
      if ('previewUrl' in p) {
        const u = typeof p.previewUrl === 'string' ? p.previewUrl.trim() : '';
        if (u && !/^https?:\/\/[^\s]+$/i.test(u)) throw new Error('Use a full address, like http://localhost:3000');
        board.previewUrl = u || undefined;
      }
      if (Array.isArray(p.links))
        board.links = p.links
          .filter((l: any) => l && typeof l.id === 'string' && typeof l.source === 'string' && typeof l.target === 'string')
          .map((l: any) => ({ id: l.id, source: l.source, target: l.target }));
      save();
      broadcast({ type: 'board', board });
      return;
    }
    case 'deleteBoard': {
      closeBoardTerminals(msg.id);
      const ids = state.nodes.filter((n) => n.boardId === msg.id).map((n) => n.id);
      dropShots(ids);
      ids.forEach(stop);
      state.nodes = state.nodes.filter((n) => n.boardId !== msg.id);
      await pruneBranches();
      state.boards = state.boards.filter((b) => b.id !== msg.id);
      save();
      broadcast({ type: 'boardDeleted', id: msg.id });
      return;
    }
    case 'clearBoard': {
      const board = getBoard(msg.id);
      if (!board) throw new Error('Board not found');
      const ids = state.nodes.filter((n) => n.boardId === msg.id).map((n) => n.id);
      ids.forEach(stop);
      dropShots(ids);
      state.nodes = state.nodes.filter((n) => n.boardId !== msg.id);
      board.links = [];
      await pruneBranches();
      broadcast({ type: 'board', board });
      broadcast({ type: 'nodesDeleted', ids });
      return;
    }
    case 'send': {
      const prompt = msg.prompt.trim();
      if (!prompt) throw new Error('Empty prompt');
      const node = await startTurn(msg.boardId, msg.parentId, prompt, goodPos(msg.position) ? msg.position : { x: 0, y: 0 });
      return { id: node.id };
    }
    case 'stop':
      stop(msg.nodeId);
      return;
    case 'permission':
      answer(msg.nodeId, msg.requestId, msg.decision, msg.answers, msg.message);
      return;
    case 'upsertNote': {
      const n = msg.note as any;
      if (!n || typeof n.id !== 'string' || !goodPos(n.position)) throw new Error('That note has no valid position.');
      if (!getBoard(n.boardId)) throw new Error('Board not found');
      const i = state.nodes.findIndex((x) => x.id === n.id);
      if (i >= 0 && state.nodes[i].kind !== 'note') throw new Error('Only notes can be edited that way.');
      const num = (v: unknown, d: number) => (Number.isFinite(v) ? Math.max(40, Math.min(4000, v as number)) : d);
      const note = {
        kind: 'note' as const,
        id: n.id.slice(0, 40),
        boardId: n.boardId,
        text: typeof n.text === 'string' ? n.text.slice(0, 100_000) : '',
        color: typeof n.color === 'string' ? n.color.slice(0, 32) : '#fde68a',
        position: { x: n.position.x, y: n.position.y },
        width: num(n.width, 220),
        height: num(n.height, 160),
        createdAt: Number.isFinite(n.createdAt) ? n.createdAt : Date.now(),
        filed: n.filed === true ? true : undefined,
        updatedAt: Date.now(),
        // Only images this note already has: a client can remove one, never point at someone else's.
        images: Array.isArray(n.images) ? n.images.filter((x: unknown) => typeof x === 'string' && (i >= 0 ? ((state.nodes[i] as any).images ?? []).includes(x) : false)) : (i >= 0 ? (state.nodes[i] as any).images : undefined),
      };
      // Images taken out of the note are deleted.
      if (i >= 0) for (const old of (state.nodes[i] as any).images ?? []) if (!note.images?.includes(old)) deleteShot(old);
      if (i >= 0) state.nodes[i] = note;
      else state.nodes.push(note);
      save();
      broadcast({ type: 'node', node: note });
      return;
    }
    case 'move':
      for (const m of msg.moves) {
        const n = getNode(m.id);
        if (!n || !goodPos(m.position)) continue;
        n.position = m.position;
        if (n.kind === 'note' && m.width) {
          n.width = m.width;
          n.height = m.height;
        }
        broadcast({ type: 'node', node: n });
      }
      save();
      return;
    case 'deleteNodes': {
      const ids = new Set(msg.ids.flatMap(subtree));
      for (const id of ids) if (isRunning(id)) stop(id);
      dropShots(ids);
      state.nodes = state.nodes.filter((n) => !ids.has(n.id));
      for (const b of state.boards) {
        const before = b.links.length;
        b.links = b.links.filter((l) => !ids.has(l.source) && !ids.has(l.target));
        if (b.links.length !== before) broadcast({ type: 'board', board: b });
      }
      // A branch whose head was deleted goes back to its newest remaining turn.
      for (const br of state.branches) {
        if (br.headNodeId && ids.has(br.headNodeId)) {
          const left = state.nodes.filter((n) => n.kind === 'turn' && n.branchId === br.id).sort((a, b) => b.createdAt - a.createdAt);
          // The worktree still holds the deleted step's files. Leave it, so the next reply
          // starts a fresh copy from the remaining step's checkpoint instead.
          br.headNodeId = br.worktree ? undefined : left[0]?.id;
          broadcast({ type: 'branch', branch: br });
        }
      }
      await pruneBranches();
      broadcast({ type: 'nodesDeleted', ids: [...ids] });
      return;
    }
    case 'openEditor': {
      const turn = getTurn(msg.nodeId);
      const dir = turn ? getBranch(turn.branchId)?.cwd : undefined;
      if (!dir) throw new Error('No folder for that turn');
      return openFolder(dir);
    }
    case 'diff': {
      const turn = getTurn(msg.nodeId);
      const board = turn && getBoard(turn.boardId);
      if (!turn?.baseCommit || !turn.commit || !board?.repoRoot) return '';
      return g.diff(board.repoRoot, turn.baseCommit, turn.commit);
    }
    case 'listSessions': {
      const board = getBoard(msg.boardId);
      if (!board) throw new Error('Board not found');
      return listImportable(board);
    }
    case 'importSessions': {
      const board = getBoard(msg.boardId);
      if (!board) throw new Error('Board not found');
      const created = await importSessions(board, msg.sessionIds, msg.at);
      for (const c of created) {
        broadcast({ type: 'branch', branch: c.branch });
        for (const n of c.nodes) broadcast({ type: 'node', node: n });
      }
      broadcast({ type: 'board', board });
      return created.map((c) => ({ branchId: c.branch.id, head: c.branch.headNodeId, turns: c.nodes.length }));
    }
    case 'serviceStatus':
      return serviceStatus();
    case 'serviceEnable':
      return enableService(PORT, () => {
        flush();
        for (const c of clients) c.close(1012, 'Moving to the background');
        server.close();
      });
    case 'serviceDisable':
      return disableService();
    case 'updateInfo':
      return checkForUpdate(!!msg.force);
    case 'applyUpdate': {
      const busy = state.nodes.some((n) => n.kind === 'turn' && (n.status === 'running' || n.status === 'waiting'));
      if (busy) throw new Error('Agents are still working. Let them finish (or stop them), then update.');
      return applyUpdate(
        !!msg.setAside,
        (stage, extra) => broadcast({ type: 'updateProgress', stage, ...extra }),
        () => {
          flush();
          for (const c of clients) c.close(1012, 'Restarting after update');
          server.close();
        },
      );
    }
    case 'organizeConcepts':
      return organizeConcepts(os.homedir());
    case 'explain': {
      const turn = getTurn(msg.nodeId);
      if (!turn) throw new Error('Step not found');
      return explain(turn, msg.path);
    }
    case 'files': {
      const branch = getBranch(msg.branchId);
      const board = branch && getBoard(branch.boardId);
      if (!branch || !board) throw new Error('Branch not found');
      return listFiles(board, branch);
    }
    case 'readFile': {
      const branch = getBranch(msg.branchId);
      const board = branch && getBoard(branch.boardId);
      if (!branch || !board) throw new Error('Branch not found');
      return readFile(board, branch, msg.path);
    }
    case 'presence':
      for (const [c] of visible) if (c === currentWs) visible.set(c, msg.visible);
      return;
    case 'ping':
      return 'pong';
    case 'termSettings': {
      if (typeof msg.remoteAllowed === 'boolean') {
        // Only this machine can let other devices in.
        if (remoteOf.get(currentWs)) throw new Error('Change this on the computer itself.');
        setTerminalRemoteAllowed(msg.remoteAllowed);
      }
      return { supported: terminalSupported(), remoteAllowed: terminalRemoteAllowed(), here: !remoteOf.get(currentWs) };
    }
    case 'termOpen':
    case 'termList':
    case 'termAttach':
    case 'termInput':
    case 'termResize':
    case 'termClose': {
      if (remoteOf.get(currentWs) && !terminalRemoteAllowed()) throw new Error('The terminal is only available on the computer itself. You can allow other devices in Settings there.');
      if (msg.type === 'termOpen') {
        const board = getBoard(msg.boardId);
        if (!board) throw new Error('Board not found');
        const branch = msg.branchId ? getBranch(msg.branchId) : undefined;
        return openTerminal(board.id, branch?.boardId === board.id ? branch.cwd : board.cwd, branch?.id, msg.cols, msg.rows);
      }
      if (msg.type === 'termList') return listTerminals(msg.boardId);
      if (msg.type === 'termAttach') return attachTerminal(msg.id);
      if (msg.type === 'termInput') return writeTerminal(msg.id, msg.data);
      if (msg.type === 'termResize') return resizeTerminal(msg.id, msg.cols, msg.rows);
      return closeTerminal(msg.id);
    }
    case 'captureShot': {
      const t = getTurn(msg.nodeId);
      const board = t && getBoard(t.boardId);
      if (!t || !board) throw new Error('Step not found');
      if (!board.previewUrl) throw new Error('Set your app\'s address in board settings first.');
      const id = await capture(board.previewUrl);
      t.shots = [...(t.shots ?? []), id].slice(-12);
      save();
      broadcast({ type: 'node', node: t });
      return { id };
    }
    case 'removeShot': {
      const t = getTurn(msg.nodeId);
      if (!t || !t.shots?.includes(msg.shotId)) return;
      t.shots = t.shots.filter((s) => s !== msg.shotId);
      deleteShot(msg.shotId);
      save();
      broadcast({ type: 'node', node: t });
      return;
    }
    case 'reviewConcept': {
      // A concept is one idea, so "Got it" applies to every lesson about it, on every step.
      const key = conceptKey(String(msg.key ?? ''));
      if (!key) return;
      for (const n of state.nodes) {
        if (n.kind !== 'turn' || !n.lessons?.length) continue;
        let changed = false;
        for (const l of n.lessons)
          if ((l.key || conceptKey(l.title)) === key && !!l.reviewed !== !!msg.reviewed) {
            l.reviewed = !!msg.reviewed || undefined;
            changed = true;
          }
        if (changed) broadcast({ type: 'node', node: n });
      }
      save();
      return;
    }
    case 'setTitle': {
      const t = getTurn(msg.nodeId);
      if (!t) throw new Error('Step not found');
      t.title = String(msg.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined;
      save();
      broadcast({ type: 'node', node: t });
      return;
    }
    case 'setCompleted': {
      const t = getTurn(msg.nodeId);
      if (!t) throw new Error('Step not found');
      t.completed = !!msg.completed;
      save();
      broadcast({ type: 'node', node: t });
      return;
    }
    case 'awayInfo':
    case 'setAway': {
      if (msg.type === 'setAway') setAway(!!msg.on, typeof msg.screen === 'boolean' ? msg.screen : undefined);
      const [away, tailscale, service] = await Promise.all([awayStatus(), tailscaleInfo(PORT), serviceStatus()]);
      return {
        away,
        tailscale,
        publicUrl: getPublicUrl(),
        service: { supported: service.supported, installed: service.installed, reason: service.reason },
        pushDevices: push.subscriptionCount(),
      };
    }
    case 'remoteInfo':
      return { tailscale: await tailscaleInfo(PORT), publicUrl: getPublicUrl(), port: PORT };
    case 'enableTailscale':
      await enableTailscaleServe(PORT);
      return { tailscale: await tailscaleInfo(PORT), publicUrl: getPublicUrl(), port: PORT };
    case 'setPublicUrl':
      if (msg.url && !/^https?:\/\//.test(msg.url.trim())) throw new Error('Use a full URL, like https://my-mac.example.com');
      setPublicUrl(msg.url);
      return { tailscale: await tailscaleInfo(PORT), publicUrl: getPublicUrl(), port: PORT };
    case 'rotateToken': {
      const token = rotateToken();
      push.clearSubscriptions();
      // Everyone else has to pair again.
      setTimeout(() => {
        for (const c of clients) if (c !== currentWs) c.close(4001, 'Access key changed');
      }, 200);
      return { token };
    }
    case 'pairCode':
      return newPairCode();
    case 'pushKey':
      return push.publicKey();
    case 'pushSubscribe':
      push.subscribe(msg.subscription as any);
      return;
    case 'pushUnsubscribe':
      push.unsubscribe(msg.endpoint);
      return;
    case 'pushStatus':
      return push.hasSubscription(msg.endpoint);
    case 'listDir': {
      const dir = expand(msg.path || '~');
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
      return { dir, parent: path.dirname(dir), entries };
    }
  }
}

const BUILD = await currentBuild();

// After an update the new process can start before the old one has let go of the port.
let listenTries = 0;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && listenTries++ < 40) return setTimeout(() => server.listen(PORT, HOST), 250);
  console.error(err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`\n  Forkspace → http://localhost:${PORT}\n`);
  // Check for updates in the background now and every few hours.
  // Look for new releases every 15 minutes and tell every open screen when something changes.
  let seen = '';
  const poll = () =>
    checkForUpdate(true)
      .then((info) => {
        const sig = `${info.releases[0]?.version ?? ''}|${info.restartPending}`;
        if (sig !== seen) {
          seen = sig;
          broadcast({ type: 'updateInfo', info });
        }
      })
      .catch(() => {});
  poll();
  setInterval(poll, Number(process.env.FORKSPACE_UPDATE_POLL_MS) || 15 * 60_000).unref();
  // Threads from before titles existed get one, quietly, one at a time.
  setTimeout(async () => {
    for (const n of state.nodes) {
      if (n.kind !== 'turn' || n.parentId || n.title || n.status !== 'done') continue;
      const b = getBranch(n.branchId);
      const text = [...n.events].reverse().find((e) => e.t === 'text' && !e.partial);
      n.title = await threadTitle(n.prompt, text && text.t === 'text' ? text.text : '', b?.cwd ?? os.homedir());
      touch(n);
    }
  }, 5000);
});

// Last line of defence: a stray rejection must never take every running agent down with it.
process.on('unhandledRejection', (err) => console.error('[forkspace] unhandled', err));

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
