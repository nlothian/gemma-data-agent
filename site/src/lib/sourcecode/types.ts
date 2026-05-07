export interface ManifestEntry {
  path: string;
  size: number;
}

export type Manifest = ManifestEntry[];

export interface SearchResult {
  path: string;
  line: number;
  col: number;
  lineText: string;
  matchStart: number;
  matchEnd: number;
}

export type SyncPhase = 'idle' | 'checking' | 'fetching' | 'unzipping' | 'ready' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  sha?: string;
  fileCount?: number;
  error?: string;
  progress?: { done: number; total: number };
}

export type SyncWorkerOut =
  | { type: 'progress'; phase: 'fetch' | 'unzip'; done: number; total: number }
  | { type: 'ready'; sha: string; fileCount: number }
  | { type: 'error'; message: string };

export type SyncWorkerIn = { type: 'sync' };

export interface SearchRequest {
  id: number;
  pattern: string;
  flags: string;
  paths: string[];
}

export type SearchWorkerOut =
  | { type: 'result'; id: number; items: SearchResult[] }
  | { type: 'timeout'; id: number; path: string }
  | { type: 'error'; id: number; path: string; message: string }
  | { type: 'done'; id: number };

export type SearchWorkerIn =
  | { type: 'search'; request: SearchRequest }
  | { type: 'cancel'; id: number };

export const OPFS_ROOT_DIR = 'sourcecode';
export const OPFS_FILES_DIR = 'files';
export const OPFS_SHA_FILE = '.sha';
export const OPFS_MANIFEST_FILE = 'manifest.json';
export const SHA_URL = '/sourcecode.sha';
export const ZIP_URL = '/sourcecode.zip';
