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
}

export interface Position {
  x: number;
  y: number;
}

export interface TurnNode {
  kind: 'turn';
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
  /** Git commit checkpoint taken when the turn finished. */
  commit?: string;
  diffStat?: { files: number; insertions: number; deletions: number };
  costUsd?: number;
  durationMs?: number;
  error?: string;
  pending?: PendingPermission;
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
  | { type: 'updateBoard'; id: string; patch: Partial<Pick<Board, 'name' | 'permissionMode' | 'model' | 'links' | 'learn' | 'previewUrl'>> }
  | { type: 'explain'; reqId: string; nodeId: string; path?: string }
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
  | { type: 'send'; reqId: string; boardId: string; parentId: string | null; prompt: string; position: Position }
  | { type: 'stop'; nodeId: string }
  | { type: 'permission'; nodeId: string; requestId: string; decision: 'allow' | 'always' | 'deny'; answers?: Record<string, string>; message?: string }
  | { type: 'upsertNote'; note: NoteNode }
  | { type: 'move'; moves: { id: string; position: Position; width?: number; height?: number }[] }
  | { type: 'deleteNodes'; ids: string[] }
  | { type: 'openEditor'; reqId: string; nodeId: string }
  | { type: 'diff'; reqId: string; nodeId: string }
  | { type: 'listDir'; reqId: string; path: string }
  | { type: 'presence'; visible: boolean }
  | { type: 'remoteInfo'; reqId: string }
  | { type: 'awayInfo'; reqId: string }
  | { type: 'ping'; reqId: string }
  | { type: 'captureShot'; reqId: string; nodeId: string }
  | { type: 'removeShot'; nodeId: string; shotId: string }
  | { type: 'setTitle'; nodeId: string; title: string }
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
export const CONCEPT_AREAS = [
  'Algorithms',
  'Data structures',
  'Language features',
  'Performance',
  'Testing',
  'Debugging',
  'Architecture and design',
  'Web and networking',
  'Data and databases',
  'Security',
  'Concurrency and async',
  'UI and frontend',
  'Tooling and build',
  'DevOps and infrastructure',
  'Version control',
] as const;

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
}
