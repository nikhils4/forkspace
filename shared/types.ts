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
  | { type: 'updateBoard'; id: string; patch: Partial<Pick<Board, 'name' | 'permissionMode' | 'model' | 'links'>> }
  | { type: 'deleteBoard'; id: string }
  | { type: 'send'; reqId: string; boardId: string; parentId: string | null; prompt: string; position: Position }
  | { type: 'stop'; nodeId: string }
  | { type: 'permission'; nodeId: string; requestId: string; decision: 'allow' | 'always' | 'deny'; answers?: Record<string, string>; message?: string }
  | { type: 'upsertNote'; note: NoteNode }
  | { type: 'move'; moves: { id: string; position: Position; width?: number; height?: number }[] }
  | { type: 'deleteNodes'; ids: string[] }
  | { type: 'openEditor'; nodeId: string }
  | { type: 'diff'; reqId: string; nodeId: string }
  | { type: 'listDir'; reqId: string; path: string };

export type ServerMsg =
  | { type: 'state'; state: State; home: string }
  | { type: 'board'; board: Board }
  | { type: 'boardDeleted'; id: string }
  | { type: 'branch'; branch: Branch }
  | { type: 'node'; node: CanvasNode }
  | { type: 'nodesDeleted'; ids: string[] }
  | { type: 'reply'; reqId: string; ok: boolean; error?: string; data?: unknown }
  | { type: 'toast'; level: 'info' | 'error'; text: string };
