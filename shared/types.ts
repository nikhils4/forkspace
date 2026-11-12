// Types shared by the server and the canvas client.

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';

export type Isolation = 'worktree' | 'none';

export interface Board {
  id: string;
  name: string;
  /** Folder the agents work in. */
  cwd: string;
  /** Git repo root when cwd is inside a repo. */
  repoRoot?: string;
  /** cwd relative to repoRoot ('' when they are the same). */
  relPath?: string;
  isolation: Isolation;
  permissionMode: PermissionMode;
  /** Your app's address while it runs (http://localhost:3000). Snapped after steps that change files. */
  previewUrl?: string;
  model?: string;
  /** How hard the model thinks on each step (unset = the model's own default). */
  effort?: EffortLevel;
  createdAt: number;
  links: Link[];
  /** Learn mode: a mentor explains what the agents do as they work. On unless turned off. */
  learn?: LearnSettings;
  /** Unused since 0.2.1: whether a session is on the board comes from its cards. Kept so old state files load. */
  imported?: string[];
}

export type LearnLevel = 'new' | 'growing' | 'expert';

export interface LearnSettings {
  on: boolean;
  level: LearnLevel;
}

export type LessonKind = 'concept' | 'why' | 'pattern' | 'watch' | 'explain';

export interface Lesson {
  id: string;
  kind: LessonKind;
  title: string;
  body: string;
  /** File the lesson is about, relative to the branch folder. */
  file?: string;
  /** A few real lines from the change. */
  snippet?: string;
  check?: { question: string; options: string[]; answer: number; why?: string };
  at: number;
  /** Canonical name, lowercase ("memoization"). Two lessons with the same key are the same concept. */
  key?: string;
  /** Where in tech the concept belongs (one of CONCEPT_AREAS). */
  area?: string;
  /** Keys of other concepts this one connects to. */
  related?: string[];
  /** You asked for this one (Explain), rather than the mentor offering it. */
  asked?: boolean;
  /** You marked it "Got it": it leaves the step views and stays in Concepts. */
  reviewed?: boolean;
  /** Practice: how well you know it (0 new … 4 solid) and when to see it again. */
  memory?: { box: number; due: number };
}

/** A user-drawn connection (note to node, node to node). */
export interface Link {
  id: string;
  source: string;
  target: string;
}

export interface Branch {
  id: string;
  boardId: string;
  /** Folder this branch's agents run in. */
  cwd: string;
  /** Worktree root (worktree isolation only). */
  worktree?: string;
  gitBranch?: string;
  /** Last turn started on this branch. A reply to it keeps the branch; a reply to anything else forks. */
  headNodeId?: string;
  /** Brought in from an existing Claude Code session; runs in the board's own folder. */
  imported?: boolean;
  /** Other threads changing the same files as this one (kept up to date while agents work). */
  overlaps?: Overlap[];
}

export interface Overlap {
  /** The other thread. */
  branchId: string;
  /** Files both changed (up to 30), relative to the project. */
  files: string[];
  count: number;
  /** copies: separate copies that will need merging. folder: two agents editing the same folder at once. */
  kind: 'copies' | 'folder';
}

export type TurnStatus = 'running' | 'waiting' | 'done' | 'error' | 'stopped';

export type TurnEvent =
  | { t: 'text'; text: string; partial?: boolean }
  | { t: 'thinking'; text: string }
  | { t: 'tool'; id: string; name: string; input: unknown; result?: string; isError?: boolean };

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  canAlways: boolean;
  /** Why it's asking, when one of Forkspace's safety rules paused it (e.g. "this uses AWS"). */
  safety?: string;
}

export interface Position {
  x: number;
  y: number;
}

/** A file attached to a prompt. Images are stored with screenshots. */
export interface Attachment {
  id: string;
  name: string;
  kind: 'image' | 'file';
  size: number;
}

/** Your own comment on a card. Never sent to the agent unless you put it in a prompt. */
export interface CardComment {
  id: string;
  text: string;
  at: number;
}

/** A map of a project: its big parts, the pieces worth knowing, and what uses what. */
export interface CodeMap {
  summary: string;
  layers: { id: string; name: string; kind: 'screens' | 'api' | 'logic' | 'data' | 'jobs' | 'infra' | 'shared'; summary: string }[];
  items: { id: string; layer: string; name: string; kind: string; path: string; line?: number; route?: string; summary: string; fields?: MapField[] }[];
  links: { from: string; to: string; label?: string }[];
  /** The main things that happen in the app, to walk through. */
  flows?: { name: string; question: string }[];
  /** Opened-up items: their files and the functions inside. */
  zoom?: Record<string, MapZoom>;
  builtAt: number;
  /** HEAD when it was drawn, to tell when the code has moved on. */
  commit?: string;
}
/** A field of a data model or table. */
export interface MapField {
  name: string;
  type?: string;
  note?: string;
}
/** A function, component or handler inside an item. */
export interface MapPart {
  name: string;
  kind: string;
  path: string;
  line?: number;
  summary: string;
  /** Map item ids it calls or reads. */
  uses?: string[];
}
export interface MapZoom {
  files: { path: string; summary: string }[];
  parts: MapPart[];
  /** Fields found when a model is opened up. */
  fields?: MapField[];
  at: number;
}
export type TableOp = 'read' | 'create' | 'update' | 'delete';
/** One stop on a walkthrough: where it happens, what happens, and what the data looks like after. */
export interface MapTraceStep {
  /** A short plain headline, like "Hold the stock". */
  title?: string;
  /** Which part of the journey, like "Before payment". */
  stage?: string;
  /** Every decision here: each if/else, early stop, error and special case. */
  checks?: { if: string; then: string; kind: 'stop' | 'skip' | 'continue' | 'retry' | 'other' }[];
  /** What changed, in words. */
  changes?: string[];
  item?: string;
  path: string;
  line?: number;
  fn?: string;
  does: string;
  /** Sample data after this step, as JSON text. */
  data?: string;
  tables?: { name: string; op: TableOp; what?: string }[];
}
export interface MapTrace {
  title: string;
  /** The sample data it starts with, as JSON text. */
  input?: string;
  steps: MapTraceStep[];
}
export interface MapAnswer {
  question: string;
  answer: string;
  /** Map item ids the answer is about. */
  focus: string[];
  /** For questions about something that happens: the path it takes, step by step. */
  trace?: MapTrace;
  /** Kept as a named flow (never dropped from the list). */
  saved?: { name: string; at: number };
  /** The thread that checked it against the real code. */
  check?: { nodeId: string; at: number };
  /** The commit it was worked out on, to tell when the code moved on. */
  commit?: string;
  at: number;
}

export interface TurnNode {
  kind: 'turn';
  /** Your comments on this card. */
  comments?: CardComment[];
  /** Images and files sent with the prompt. */
  attachments?: Attachment[];
  /** Screenshots attached to this step, oldest first. */
  shots?: string[];
  /** On a thread's first step: the thread's title (from Claude Code, written for you, or yours). */
  title?: string;
  /** Subject of this step's checkpoint commit. */
  commitMessage?: string;
  /** You marked this step finished: it and everything after it fade on the canvas. */
  completed?: boolean;
  id: string;
  boardId: string;
  parentId: string | null;
  branchId: string;
  prompt: string;
  events: TurnEvent[];
  status: TurnStatus;
  sessionId?: string;
  /** HEAD when the turn started. */
  baseCommit?: string;
  /** Checked once that baseCommit counts only this step's own work (see repairStepBases). */
  baseRepaired?: boolean;
  /** Git commit checkpoint taken when the turn finished. */
  commit?: string;
  diffStat?: { files: number; insertions: number; deletions: number };
  costUsd?: number;
  durationMs?: number;
  error?: string;
  pending?: PendingPermission;
  /** Messages you sent while this step was working. They run as the next step once it finishes. */
  queued?: QueuedMessage[];
  lessons?: Lesson[];
  /** Imported turns: resume the session at this message to continue from exactly here. */
  resumeAt?: string;
  imported?: boolean;
  /** Mentor is writing a lesson right now. */
  learning?: boolean;
  position: Position;
  createdAt: number;
  finishedAt?: number;
}

export interface QueuedMessage {
  id: string;
  prompt: string;
  attachments?: Attachment[];
  /** Where the next step's card goes (worked out when you sent it). */
  position: Position;
  at: number;
}

export interface NoteNode {
  kind: 'note';
  id: string;
  boardId: string;
  text: string;
  color: string;
  position: Position;
  width?: number;
  height?: number;
  createdAt: number;
  /** Images pasted or dropped into the note (screenshot ids). */
  images?: string[];
  /** Filed away in Notes: kept and editable, but off the canvas. */
  filed?: boolean;
  /** When it was last edited (for sorting in Notes). */
  updatedAt?: number;
}

export type CanvasNode = TurnNode | NoteNode;

export interface State {
  boards: Board[];
  branches: Branch[];
  nodes: CanvasNode[];
}

// ---- wire protocol ----

export type ClientMsg =
  | { type: 'createBoard'; reqId: string; name: string; cwd: string; isolation: Isolation; permissionMode: PermissionMode }
  | { type: 'updateBoard'; id: string; patch: Partial<Pick<Board, 'name' | 'permissionMode' | 'model' | 'effort' | 'links' | 'learn' | 'previewUrl'>> }
  | { type: 'explain'; reqId: string; nodeId: string; path?: string }
  /** Fix what speech recognition misheard, using the board's file names and recent prompts. */
  | { type: 'tidyDictation'; reqId: string; boardId: string; text: string; before?: string }
  | { type: 'listSessions'; reqId: string; boardId: string }
  | { type: 'importSessions'; reqId: string; boardId: string; sessionIds: string[]; at: Position }
  | { type: 'updateInfo'; reqId: string; force?: boolean }
  /** setAside: stash local edits that would block the update (kept in `git stash list`). */
  | { type: 'applyUpdate'; reqId: string; setAside?: boolean }
  | { type: 'serviceStatus'; reqId: string }
  | { type: 'serviceEnable'; reqId: string }
  | { type: 'serviceDisable'; reqId: string }
  | { type: 'deleteBoard'; id: string }
  /** Start fresh: remove every step, note and worktree but keep the board and its settings. */
  | { type: 'clearBoard'; id: string }
  | { type: 'send'; reqId: string; boardId: string; parentId: string | null; prompt: string; position: Position; attachments?: Attachment[] }
  | { type: 'stop'; nodeId: string }
  /** Drop one message waiting on a working step. */
  | { type: 'unqueue'; reqId: string; nodeId: string; id: string }
  /** Run a step's waiting messages now (it stopped or failed, so they didn't go on their own). */
  | { type: 'sendQueued'; reqId: string; nodeId: string }
  | { type: 'permission'; nodeId: string; requestId: string; decision: 'allow' | 'always' | 'deny'; answers?: Record<string, string>; message?: string }
  | { type: 'upsertNote'; note: NoteNode }
  | { type: 'move'; moves: { id: string; position: Position; width?: number; height?: number }[] }
  | { type: 'deleteNodes'; ids: string[] }
  | { type: 'openEditor'; reqId: string; nodeId: string }
  | { type: 'diff'; reqId: string; nodeId: string }
  | { type: 'listDir'; reqId: string; path: string }
  | { type: 'listModels'; reqId: string }
  | { type: 'presence'; visible: boolean }
  | { type: 'remoteInfo'; reqId: string }
  | { type: 'awayInfo'; reqId: string }
  | { type: 'ping'; reqId: string }
  | { type: 'reviewConcept'; key: string; reviewed: boolean }
  | { type: 'captureShot'; reqId: string; nodeId: string }
  | { type: 'removeShot'; nodeId: string; shotId: string }
  | { type: 'setTitle'; nodeId: string; title: string }
  | { type: 'mapGet'; reqId: string; boardId: string }
  | { type: 'mapBuild'; reqId: string; boardId: string }
  | { type: 'mapAsk'; reqId: string; boardId: string; question: string; replace?: number }
  | { type: 'mapSave'; reqId: string; boardId: string; at: number; name: string | null }
  | { type: 'mapCheck'; reqId: string; boardId: string; at: number; nodeId: string }
  | { type: 'mapZoom'; reqId: string; boardId: string; itemId: string }
  | { type: 'mapForget'; reqId: string; boardId: string; at: number }
  /** Practice: you knew it (or not). Spaces out when you see it next. */
  | { type: 'practiceConcept'; key: string; knew: boolean }
  | { type: 'setComments'; nodeId: string; comments: CardComment[] }
  | { type: 'termOpen'; reqId: string; boardId: string; branchId?: string; cols: number; rows: number }
  | { type: 'termList'; reqId: string; boardId: string }
  | { type: 'termAttach'; reqId: string; id: string }
  | { type: 'termInput'; id: string; data: string }
  | { type: 'termResize'; id: string; cols: number; rows: number }
  | { type: 'termClose'; id: string }
  | { type: 'termSettings'; reqId: string; remoteAllowed?: boolean }
  | { type: 'setCompleted'; nodeId: string; completed: boolean }
  | { type: 'organizeConcepts'; reqId: string }
  | { type: 'setAway'; reqId: string; on: boolean; screen?: boolean }
  | { type: 'enableTailscale'; reqId: string }
  | { type: 'setPublicUrl'; reqId: string; url: string }
  | { type: 'rotateToken'; reqId: string }
  | { type: 'pushKey'; reqId: string }
  | { type: 'pairCode'; reqId: string }
  | { type: 'files'; reqId: string; branchId: string }
  | { type: 'readFile'; reqId: string; branchId: string; path: string }
  | { type: 'pushSubscribe'; reqId: string; subscription: unknown }
  | { type: 'pushUnsubscribe'; reqId: string; endpoint: string }
  | { type: 'pushStatus'; reqId: string; endpoint: string };

export interface RemoteInfo {
  tailscale: { installed: boolean; running: boolean; url?: string; serving: boolean };
  publicUrl?: string;
  port: number;
}

export type ServerMsg =
  /** What the map builder or a question is reading right now. */
  | { type: 'mapProgress'; boardId: string; text: string }
  | { type: 'state'; state: State; home: string; build: string; startCommand: string }
  | { type: 'updateProgress'; stage: string; done?: boolean; error?: string }
  /** Pushed when a check finds something new, so every screen knows without asking. */
  | { type: 'updateInfo'; info: UpdateInfo }
  | { type: 'termData'; id: string; data: string }
  | { type: 'termExit'; id: string; code: number }
  /** Terminals on a board changed (one opened or closed). */
  | { type: 'termList'; boardId: string }
  | { type: 'board'; board: Board }
  | { type: 'boardDeleted'; id: string }
  | { type: 'branch'; branch: Branch }
  | { type: 'node'; node: CanvasNode }
  | { type: 'nodesDeleted'; ids: string[] }
  | { type: 'reply'; reqId: string; ok: boolean; error?: string; data?: unknown }
  | { type: 'toast'; level: 'info' | 'error'; text: string };

export interface ChangedFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'T' | 'U' | 'C';
  add: number;
  del: number;
}

export interface FilesResult {
  root: string;
  files: string[];
  /** Everything this thread changed since it started (committed checkpoints plus work in progress). */
  changed: ChangedFile[];
  truncated: boolean;
  git: boolean;
}

export interface FileResult {
  path: string;
  text: string;
  /** Content when the thread started ('' if the file is new). Absent outside git. */
  base?: string;
  exists: boolean;
  binary?: boolean;
  tooLarge?: boolean;
  size?: number;
}

export interface ImportableSession {
  sessionId: string;
  title: string;
  firstPrompt?: string;
  lastModified: number;
  gitBranch?: string;
  sizeKb?: number;
  imported: boolean;
}

export interface Release {
  version: string;
  /** "2 days ago" */
  when: string;
  notes: string[];
}

export interface UpdateInfo {
  /** 'git' when installed from a git clone; otherwise updates go through your package manager. */
  channel: 'git' | 'none';
  /** Version that is running right now. */
  version: string;
  commit?: string;
  /** Newer releases than the running one, newest first. */
  releases: Release[];
  /** The folder already holds newer code than what is running (pulled by hand, or an update that did not restart). */
  restartPending: boolean;
  /** Local edits that the update would overwrite. Edits to other files are fine. */
  conflicts: string[];
  dev: boolean;
  checkedAt?: number;
  error?: string;
}

/** What an export file holds, shown before importing it. */
export interface ImportPlan {
  id: string;
  exportedAt: number;
  boards: {
    id: string;
    name: string;
    oldCwd: string;
    /** Best guess for the folder on this machine. */
    suggested: string;
    found: boolean;
    /** A board with this id is already here; it will be skipped. */
    already: boolean;
    steps: number;
    notes: number;
    /** Branch code is in the file. */
    code: boolean;
    /** The board ran with Full access; it is imported as Ask me. */
    fullAccess: boolean;
  }[];
}

export interface ImportResult {
  name: string;
  ok: boolean;
  note: string;
}

export interface AwayStatus {
  on: boolean;
  /** Keep the screen on too, not just the computer. */
  screen: boolean;
  since?: number;
  supported: boolean;
  method?: string;
  /** The keep-awake helper is running right now. */
  active: boolean;
  error?: string;
  onBattery?: boolean;
  platform: string;
  /** Devices connected from outside this machine right now (phones over Tailscale). */
  remoteConnected: number;
  remoteSeen?: { at: number; device: string };
}

/** Everything the away mode setup checks, in one answer. */
export interface AwayInfo {
  away: AwayStatus;
  tailscale: RemoteInfo['tailscale'];
  publicUrl?: string;
  service: { supported: boolean; installed: boolean; reason?: string };
  /** Devices that will get a notification when an agent needs you. */
  pushDevices: number;
}

/** Where a concept lives in tech. Used to group the concept map. */
/**
 * Ten plain topics, sorted by the problem an idea solves (so nothing belongs in two places).
 * Caching that makes things faster is Speed; the HTTP rules behind it are Servers & APIs.
 */
export const CONCEPT_AREAS = [
  'Problem solving',
  'The language',
  'Code structure',
  'Screens',
  'Servers & APIs',
  'Data',
  'Speed',
  'Safety',
  'Testing & debugging',
  'Tools & shipping',
] as const;

/** What each topic holds, in a few words (shown on the page and given to the model). */
export const AREA_HINTS: Record<string, string> = {
  'Problem solving': 'Algorithms, data structures, recursion: ways to work a problem out',
  'The language': 'Features of the language itself: types, closures, async and await',
  'Code structure': 'How code is split up and fits together: modules, components, patterns',
  Screens: 'What people see and touch: rendering, state, styling, accessibility',
  'Servers & APIs': 'How apps talk: requests, routes, HTTP, auth flows, real time',
  Data: 'Keeping information: databases, schemas, queries, storage',
  Speed: 'Making things fast: caching, memoizing, doing work at once',
  Safety: 'Keeping things safe and correct: security, validation, error handling',
  'Testing & debugging': 'Proving it works and finding out why it does not',
  'Tools & shipping': 'Git, builds, packages, deploys and the machines it runs on',
};

/** Topics from older versions, mapped to today's. */
const LEGACY_AREAS: Record<string, string> = {
  Algorithms: 'Problem solving',
  'Data structures': 'Problem solving',
  'Language features': 'The language',
  Performance: 'Speed',
  Testing: 'Testing & debugging',
  Debugging: 'Testing & debugging',
  'Architecture and design': 'Code structure',
  'Web and networking': 'Servers & APIs',
  'Data and databases': 'Data',
  Security: 'Safety',
  'Concurrency and async': 'The language',
  'UI and frontend': 'Screens',
  'Tooling and build': 'Tools & shipping',
  'DevOps and infrastructure': 'Tools & shipping',
  'Version control': 'Tools & shipping',
};

/** Today's topic for any stored area (old names included), or undefined. */
export function topicOf(area?: string): string | undefined {
  if (!area) return undefined;
  if ((CONCEPT_AREAS as readonly string[]).includes(area)) return area;
  return LEGACY_AREAS[area];
}

/** Normalise a concept key so small differences ("Memoization!", "memoization ") match. */
export const conceptKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export interface TerminalInfo {
  id: string;
  boardId: string;
  branchId?: string;
  cwd: string;
  title: string;
  createdAt: number;
  /** Exit code once the shell has ended. */
  exited?: number;
  /** A command has been run here (Enter pressed). Unused terminals get reused for the next card. */
  used?: boolean;
  /** What's running in it right now (e.g. "yarn", "node"), when it's not just the shell waiting. */
  running?: string;
}

/** A model you can pick for a board (from your Claude account's list). */
export interface ModelChoice {
  /** What to ask for: an alias ("opus") or a full id ("claude-mythos-5-2"). "default" = your Claude Code setting. */
  value: string;
  name: string;
  description: string;
  /** The exact model an alias stands for right now. */
  resolved?: string;
  /** Effort levels this model accepts (none = it doesn't take one). */
  efforts?: EffortLevel[];
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
