/**
 * External store for the ExecutionPanel UI.
 *
 * Three panes (Data, Python, SQL) plus an `activeTab`. The agent tool
 * dispatch in `agentTools.ts` drives lifecycle transitions:
 *   setPending|setDataPending -> setRunning -> set{Sql,Python,Data}Result
 * or setAborted on gate abort.
 */

import type { RunLoadDataResult, RunPythonResult, RunSQLResult } from './agentTools';
import type { LoadedTable, TabularResult } from './duckdb';

export type PaneKind = 'data' | 'python' | 'sql';
export type PaneStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'aborted';

export interface PythonPaneState {
  source: string;
  status: PaneStatus;
  stdout: string;
  stderr: string;
  result?: string;
  errorMessage?: string;
  images: string[];
}

export interface SqlPaneState {
  source: string;
  status: PaneStatus;
  tabular?: TabularResult;
  errorMessage?: string;
}

export interface DataPaneState {
  status: PaneStatus;
  pendingUrl?: string;
  pendingTable?: string;
  tables: LoadedTable[];
  errorMessage?: string;
}

export interface LlmActivityState {
  active: boolean;
}

export interface ExecutionPanelSnapshot {
  activeTab: PaneKind;
  python: PythonPaneState;
  sql: SqlPaneState;
  data: DataPaneState;
  llm: LlmActivityState;
}

const MAX_STREAM_BYTES = 200_000;

const INITIAL_PYTHON: PythonPaneState = {
  source: '',
  status: 'idle',
  stdout: '',
  stderr: '',
  images: [],
};

const INITIAL_SQL: SqlPaneState = {
  source: '',
  status: 'idle',
};

const INITIAL_DATA: DataPaneState = {
  status: 'idle',
  tables: [],
};

const INITIAL_LLM: LlmActivityState = {
  active: false,
};

const INITIAL_SNAPSHOT: ExecutionPanelSnapshot = {
  activeTab: 'data',
  python: INITIAL_PYTHON,
  sql: INITIAL_SQL,
  data: INITIAL_DATA,
  llm: INITIAL_LLM,
};

type Listener = () => void;

let snapshot: ExecutionPanelSnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) fn();
}

function setSnapshot(next: ExecutionPanelSnapshot): void {
  snapshot = next;
  notify();
}

export function getSnapshot(): ExecutionPanelSnapshot {
  return snapshot;
}

export function getServerSnapshot(): ExecutionPanelSnapshot {
  return INITIAL_SNAPSHOT;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setActiveTab(tab: PaneKind): void {
  if (snapshot.activeTab === tab) return;
  setSnapshot({ ...snapshot, activeTab: tab });
}

export function setPending(kind: 'python' | 'sql', source: string): void {
  if (kind === 'python') {
    revokePythonImages();
    setSnapshot({
      ...snapshot,
      activeTab: 'python',
      python: {
        source,
        status: 'pending',
        stdout: '',
        stderr: '',
        images: [],
      },
    });
    return;
  }
  setSnapshot({
    ...snapshot,
    activeTab: 'sql',
    sql: {
      source,
      status: 'pending',
    },
  });
}

export function setDataPending(tableName: string, url: string): void {
  setSnapshot({
    ...snapshot,
    activeTab: 'data',
    data: {
      ...snapshot.data,
      status: 'pending',
      pendingUrl: url,
      pendingTable: tableName,
      errorMessage: undefined,
    },
  });
}

export function setRunning(kind: PaneKind): void {
  if (kind === 'python') {
    setSnapshot({
      ...snapshot,
      python: { ...snapshot.python, status: 'running' },
    });
  } else if (kind === 'sql') {
    setSnapshot({
      ...snapshot,
      sql: { ...snapshot.sql, status: 'running' },
    });
  } else {
    setSnapshot({
      ...snapshot,
      data: { ...snapshot.data, status: 'running' },
    });
  }
}

export function setPythonResult(res: RunPythonResult): void {
  if ('error' in res) {
    setSnapshot({
      ...snapshot,
      python: {
        ...snapshot.python,
        status: 'error',
        stdout: capStream(res.stdout ?? ''),
        stderr: capStream(res.stderr ?? ''),
        errorMessage: res.error,
        result: undefined,
      },
    });
    return;
  }
  const imageUrls = imagesToObjectUrls(res.images);
  setSnapshot({
    ...snapshot,
    python: {
      ...snapshot.python,
      status: 'done',
      stdout: capStream(res.stdout),
      stderr: capStream(res.stderr),
      result: stringifyResult(res.result),
      errorMessage: undefined,
      images: imageUrls.length > 0 ? imageUrls : snapshot.python.images,
    },
  });
}

function imagesToObjectUrls(images: Uint8Array[] | undefined): string[] {
  if (!images || images.length === 0) return [];
  if (typeof URL === 'undefined' || typeof Blob === 'undefined') return [];
  return images.map((bytes) =>
    URL.createObjectURL(
      new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
    ),
  );
}

function revokePythonImages(): void {
  if (typeof URL === 'undefined') return;
  for (const url of snapshot.python.images) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
}

export function setSqlResult(res: RunSQLResult): void {
  if ('error' in res) {
    setSnapshot({
      ...snapshot,
      sql: {
        ...snapshot.sql,
        status: 'error',
        tabular: undefined,
        errorMessage: res.error,
      },
    });
    return;
  }
  setSnapshot({
    ...snapshot,
    sql: {
      ...snapshot.sql,
      status: 'done',
      tabular: res,
      errorMessage: undefined,
    },
  });
}

export function setDataResult(res: RunLoadDataResult): void {
  if ('error' in res) {
    setSnapshot({
      ...snapshot,
      data: {
        ...snapshot.data,
        status: 'error',
        errorMessage: res.error,
      },
    });
    return;
  }
  const next = snapshot.data.tables.filter((t) => t.name !== res.name);
  next.push(res);
  setSnapshot({
    ...snapshot,
    data: {
      ...snapshot.data,
      status: 'done',
      tables: next,
      pendingUrl: undefined,
      pendingTable: undefined,
      errorMessage: undefined,
    },
  });
}

export function setAborted(kind: PaneKind): void {
  if (kind === 'python') {
    setSnapshot({
      ...snapshot,
      python: { ...snapshot.python, status: 'aborted' },
    });
  } else if (kind === 'sql') {
    setSnapshot({
      ...snapshot,
      sql: { ...snapshot.sql, status: 'aborted' },
    });
  } else {
    setSnapshot({
      ...snapshot,
      data: { ...snapshot.data, status: 'aborted' },
    });
  }
}

export function setLlmActive(active: boolean): void {
  if (snapshot.llm.active === active) return;
  setSnapshot({ ...snapshot, llm: { active } });
}

export function resetPanel(): void {
  revokePythonImages();
  setSnapshot(INITIAL_SNAPSHOT);
}

function capStream(s: string): string {
  if (s.length <= MAX_STREAM_BYTES) return s;
  return s.slice(0, MAX_STREAM_BYTES) + '\n... (truncated)';
}

function stringifyResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  try {
    return String(value);
  } catch {
    return undefined;
  }
}
