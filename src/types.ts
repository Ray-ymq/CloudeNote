export type Tree = Record<string, string>;
export const emptyTree = (): Tree => Object.create(null) as Tree;
export const copyTree = (tree: Tree): Tree => Object.assign(emptyTree(), tree);
export type Change = { path: string; before?: string; after?: string };
export type Conflict = Change & { base?: string; localDevice: string; remoteDevice: string };
export type Choice = 'local' | 'remote' | 'both';
export interface Preview {
  id: string;
  kind: 'pull' | 'sync' | 'restore';
  local?: string;
  remote?: string;
  target: Tree;
  expected: Tree;
  changes: Change[];
  conflicts: Conflict[];
  choices: Record<string, Choice>;
  label: string;
  source?: string;
}
export interface Settings {
  gitPath: string;
  remote: string;
  deviceId: string;
  deviceName: string;
  autoSync: boolean;
  connectionTested: boolean;
  aiEnabled: boolean;
  aiNamesOnly: boolean;
  aiModel: string;
  secretName: string;
}
export interface SyncState {
  phase: 'idle' | 'busy' | 'conflict' | 'pending' | 'error';
  message: string;
  pendingCommit: number;
  pendingPush: number;
  pendingPull: number;
  conflicts: number;
  skipped: { path: string; reason: string }[];
  lastSuccess?: string;
  aiFallback?: string;
}
export interface HistoryEntry { hash: string; date: string; device: string; deviceId: string; message: string }
export interface Snapshot { ref: string; hash: string; name: string; date: string }
export interface MessageResult { message: string; source: 'default' | 'ai'; reason?: string }
export type MessageGenerator = (changes: Change[], read: (oid: string) => Promise<Buffer>) => Promise<MessageResult>;
export const MAX_FILE = 100 * 1024 * 1024;
