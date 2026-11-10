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
  model?: string;
  createdAt: number;
  links: Link[];
  /** Learn mode: a mentor explains what the agents do as they work. On unless turned off. */
  learn?: LearnSettings;
  /** Claude Code sessions already brought in, so they are not offered twice. */
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
  | { type: 'updateBoard'; id: string; patch: Partial<Pick<Board, 'name' | 'permissionMode' | 'model' | 'links' | 'learn'>> }
  | { type: 'explain'; reqId: string; nodeId: string; path?: string }
  | { type: 'listSessions'; reqId: string; boardId: string }
  | { type: 'importSessions'; reqId: string; boardId: string; sessionIds: string[]; at: Position }
  | { type: 'updateInfo'; reqId: string; force?: boolean }
  | { type: 'applyUpdate'; reqId: string }
  | { type: 'deleteBoard'; id: string }
  | { type: 'send'; reqId: string; boardId: string; parentId: string | null; prompt: string; position: Position }
  | { type: 'stop'; nodeId: string }
  | { type: 'permission'; nodeId: string; requestId: string; decision: 'allow' | 'always' | 'deny'; answers?: Record<string, string>; message?: string }
  | { type: 'upsertNote'; note: NoteNode }
  | { type: 'move'; moves: { id: string; position: Position; width?: number; height?: number }[] }
  | { type: 'deleteNodes'; ids: string[] }
  | { type: 'openEditor'; nodeId: string }
  | { type: 'diff'; reqId: string; nodeId: string }
  | { type: 'listDir'; reqId: string; path: string }
  | { type: 'presence'; visible: boolean }
  | { type: 'remoteInfo'; reqId: string }
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
  | { type: 'state'; state: State; home: string; build: string }
  | { type: 'updateProgress'; stage: string; done?: boolean; error?: string }
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

export interface UpdateInfo {
  /** 'git' when installed from a git clone; otherwise updates go through your package manager. */
  channel: 'git' | 'none';
  version: string;
  commit?: string;
  behind: number;
  changes: { hash: string; subject: string; when: string }[];
  dirty: boolean;
  dev: boolean;
  checkedAt?: number;
  error?: string;
}
