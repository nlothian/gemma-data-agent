/**
 * External store for the ExecutionPanel UI.
 *
 * Three panes (Data, Python, SQL) plus an `activeTab`. The agent tool
 * dispatch in `agentTools.ts` drives lifecycle transitions:
 *   setPending|setDataPending -> setRunning -> set{Sql,Python,Data}Result
 * or setAborted on gate abort.
 */

import type {
  LoadedSandboxFileResult,
  RunLoadDataResult,
  RunPythonResult,
  RunSQLPanelResult,
} from './agentTools';
import type { LoadedTable, TabularResult } from './duckdb';
import type { RunReactResult } from './reactSandbox';
import { savePanelSnapshot, loadPanelSnapshot } from './registryPersistence';
import { registerCache, type Cache } from './cacheRegistry';

function isSandboxFileResult(
  res: LoadedTable | LoadedSandboxFileResult,
): res is LoadedSandboxFileResult {
  return (res as LoadedSandboxFileResult).kind === 'sandbox-file';
}

export type PaneKind = 'data' | 'python' | 'sql' | 'react' | 'subagents' | 'file';
export type PaneStatus =
  | 'idle'
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'aborted';

export interface PythonPaneState {
  source: string;
  /** Virtual path of the script being executed, when known. */
  path?: string;
  status: PaneStatus;
  stdout: string;
  stderr: string;
  result?: string;
  errorMessage?: string;
  /**
   * Object URLs for the rendered <img> tags. Tied to the page lifetime and
   * regenerated from `imageBytes` on rehydrate.
   */
  images: string[];
  /**
   * The original PNG bytes captured from matplotlib. Kept alongside `images`
   * so the panel can be persisted to IndexedDB and reload-rehydrated; object
   * URLs themselves don't survive a reload.
   */
  imageBytes: Uint8Array[];
}

export interface SqlPaneState {
  source: string;
  path?: string;
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

export interface ReactCompileErrorView {
  message: string;
  line?: number;
  column?: number;
}

export interface ReactRuntimeErrorView {
  message: string;
  stack?: string;
}

export interface ReactPaneState {
  source: string;
  path?: string;
  status: PaneStatus;
  compileErrors: ReactCompileErrorView[];
  runtimeErrors: ReactRuntimeErrorView[];
  /**
   * Bumped on each result so that ReactPanel knows when to re-mount the
   * iframe inside the View sub-tab — independent of `source`, since the user
   * may re-run the same code and still want a fresh render.
   */
  resultGeneration: number;
}

export interface FilePaneState {
  path?: string;
  content: string;
  status: PaneStatus;
  errorMessage?: string;
  /** Bumped on each result so CodeView re-mounts on identical text. */
  generation: number;
}

export interface LlmActivityState {
  active: boolean;
  /**
   * True while an isolated, off-thread compaction call is in flight (see
   * `compactConversation.ts`). Surfaced by the Throbber as "Compacting" and
   * takes priority over the regular "Thinking" label.
   */
  compacting: boolean;
  /**
   * Set while the body-side parser in `streamLocalGemma` is holding back an
   * in-progress `<|tool_call>...<tool_call|>` block (the closing tag hasn't
   * arrived yet). `name` is filled once the `call:NAME{` prefix is parseable;
   * until then it's null. Cleared as soon as the call is fully parsed (the
   * pane status takes over) or the stream ends.
   */
  preparingToolCall: { name: string | null } | null;
  modelDownload: { label: string; pct: number; fromCache: boolean } | null;
}

export interface ExecutionPanelSnapshot {
  activeTab: PaneKind;
  python: PythonPaneState;
  sql: SqlPaneState;
  data: DataPaneState;
  react: ReactPaneState;
  file: FilePaneState;
  llm: LlmActivityState;
  /**
   * True while we're rehydrating panel + registry state from IndexedDB after
   * a page reload. The Throbber surfaces this as "Reconstructing state" and
   * the chat composer should refuse to send tool calls until it clears.
   */
  restoring: boolean;
}

const MAX_STREAM_BYTES = 200_000;

const INITIAL_PYTHON: PythonPaneState = {
  source: '',
  status: 'idle',
  stdout: '',
  stderr: '',
  images: [],
  imageBytes: [],
};

const INITIAL_SQL: SqlPaneState = {
  source: '',
  status: 'idle',
};

const INITIAL_DATA: DataPaneState = {
  status: 'idle',
  tables: [],
};

const INITIAL_REACT: ReactPaneState = {
  source: '',
  status: 'idle',
  compileErrors: [],
  runtimeErrors: [],
  resultGeneration: 0,
};

const INITIAL_FILE: FilePaneState = {
  content: '',
  status: 'idle',
  generation: 0,
};

const INITIAL_LLM: LlmActivityState = {
  active: false,
  compacting: false,
  preparingToolCall: null,
  modelDownload: null,
};

const INITIAL_SNAPSHOT: ExecutionPanelSnapshot = {
  activeTab: 'data',
  python: INITIAL_PYTHON,
  sql: INITIAL_SQL,
  data: INITIAL_DATA,
  react: INITIAL_REACT,
  file: INITIAL_FILE,
  llm: INITIAL_LLM,
  restoring: false,
};

type Listener = () => void;

let snapshot: ExecutionPanelSnapshot = INITIAL_SNAPSHOT;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) fn();
}

const PERSIST_DEBOUNCE_MS = 500;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

interface PersistedPanelSnapshot {
  activeTab: PaneKind;
  python: Omit<PythonPaneState, 'images'>;
  sql: SqlPaneState;
  data: DataPaneState;
  react?: Omit<ReactPaneState, 'resultGeneration'>;
  file?: { path?: string };
}

function buildPersisted(s: ExecutionPanelSnapshot): PersistedPanelSnapshot {
  // Drop transient session state: live `images` (object URLs) are useless
  // across reloads — `imageBytes` is the canonical form. `llm` is session-
  // runtime (download progress, "thinking" flag) and shouldn't persist.
  // For react, drop `resultGeneration` (the live iframe is gone after a
  // reload anyway, so we don't want a stale generation triggering a re-mount).
  const { images: _imgs, ...persistedPython } = s.python;
  const { resultGeneration: _gen, ...persistedReact } = s.react;
  return {
    activeTab: s.activeTab,
    python: persistedPython,
    sql: s.sql,
    data: s.data,
    react: persistedReact,
    file: { path: s.file.path },
  };
}

function schedulePersist(): void {
  if (snapshot.restoring) return;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const persisted = buildPersisted(snapshot);
    void savePanelSnapshot(persisted).catch((err) => {
      console.warn('panelPersistence: save failed:', err);
    });
  }, PERSIST_DEBOUNCE_MS);
}

function setSnapshot(next: ExecutionPanelSnapshot): void {
  snapshot = next;
  notify();
  schedulePersist();
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

export function setPending(
  kind: 'python' | 'sql' | 'react',
  source: string,
  path?: string,
): void {
  if (kind === 'python') {
    revokePythonImages();
    setSnapshot({
      ...snapshot,
      activeTab: 'python',
      python: {
        source,
        path,
        status: 'pending',
        stdout: '',
        stderr: '',
        images: [],
        imageBytes: [],
      },
    });
    return;
  }
  if (kind === 'react') {
    setSnapshot({
      ...snapshot,
      activeTab: 'react',
      react: {
        ...snapshot.react,
        source,
        path,
        status: 'pending',
        compileErrors: [],
        runtimeErrors: [],
      },
    });
    return;
  }
  setSnapshot({
    ...snapshot,
    activeTab: 'sql',
    sql: {
      source,
      path,
      status: 'pending',
    },
  });
}

export function setFilePending(path: string): void {
  setSnapshot({
    ...snapshot,
    activeTab: 'file',
    file: {
      ...snapshot.file,
      path,
      status: 'pending',
      errorMessage: undefined,
    },
  });
}

export function setFileResult(path: string, content: string): void {
  setSnapshot({
    ...snapshot,
    file: {
      ...snapshot.file,
      path,
      content,
      status: 'done',
      errorMessage: undefined,
      generation: snapshot.file.generation + 1,
    },
  });
}

export function setFileError(path: string, errorMessage: string): void {
  setSnapshot({
    ...snapshot,
    file: {
      ...snapshot.file,
      path,
      status: 'error',
      errorMessage,
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
  } else if (kind === 'react') {
    setSnapshot({
      ...snapshot,
      react: { ...snapshot.react, status: 'running' },
    });
  } else if (kind === 'file') {
    setSnapshot({
      ...snapshot,
      file: { ...snapshot.file, status: 'running' },
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
  const newImageBytes = res.images && res.images.length > 0 ? res.images : undefined;
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
      imageBytes: newImageBytes ?? snapshot.python.imageBytes,
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

export function setReactResult(res: RunReactResult): void {
  const status: PaneStatus = res.ok ? 'done' : 'error';
  setSnapshot({
    ...snapshot,
    react: {
      ...snapshot.react,
      status,
      compileErrors: res.compileErrors,
      runtimeErrors: res.runtimeErrors,
      resultGeneration: snapshot.react.resultGeneration + 1,
    },
  });
}

export function setSqlResult(res: RunSQLPanelResult): void {
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
  // Non-tabular sandbox loads: registry is updated by sandboxFiles, no table.
  if (isSandboxFileResult(res)) {
    setSnapshot({
      ...snapshot,
      data: {
        ...snapshot.data,
        status: 'done',
        pendingUrl: undefined,
        pendingTable: undefined,
        errorMessage: undefined,
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

export function removeDataTables(names: Iterable<string>): void {
  const drop = new Set(names);
  if (drop.size === 0) return;
  const next = snapshot.data.tables.filter((t) => !drop.has(t.name));
  if (next.length === snapshot.data.tables.length) return;
  setSnapshot({
    ...snapshot,
    data: { ...snapshot.data, tables: next },
  });
}

const panelTablesCache: Cache = {
  id: 'panelTables',
  list: () =>
    snapshot.data.tables.map((t) => ({
      name: t.name,
      source: t.source,
      sourcePath: t.sourcePath,
    })),
  invalidateNames: async (names) => removeDataTables(names),
};

registerCache(panelTablesCache);

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
  } else if (kind === 'react') {
    setSnapshot({
      ...snapshot,
      react: { ...snapshot.react, status: 'aborted' },
    });
  } else if (kind === 'file') {
    setSnapshot({
      ...snapshot,
      file: { ...snapshot.file, status: 'aborted' },
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
  setSnapshot({ ...snapshot, llm: { ...snapshot.llm, active } });
}

export function setLlmCompacting(compacting: boolean): void {
  if (snapshot.llm.compacting === compacting) return;
  setSnapshot({ ...snapshot, llm: { ...snapshot.llm, compacting } });
}

/**
 * Push a partial source string into a code pane while the model is still
 * streaming the tool-call body. Switches to the pane's tab and updates
 * `source`, but leaves `status` alone — the pane isn't actually pending yet
 * (the agent dispatch will call `setPending` once the full call is parsed).
 * The ExecutionPanel auto-unfolds the code editor on `source` change.
 */
export function setStreamingSource(
  kind: 'python' | 'sql' | 'react',
  source: string,
): void {
  if (kind === 'python') {
    if (snapshot.activeTab === 'python' && snapshot.python.source === source) return;
    revokePythonImages();
    setSnapshot({
      ...snapshot,
      activeTab: 'python',
      python: {
        ...snapshot.python,
        source,
        stdout: '',
        stderr: '',
        result: undefined,
        errorMessage: undefined,
        images: [],
        imageBytes: [],
      },
    });
    return;
  }
  if (kind === 'sql') {
    if (snapshot.activeTab === 'sql' && snapshot.sql.source === source) return;
    setSnapshot({
      ...snapshot,
      activeTab: 'sql',
      sql: { ...snapshot.sql, source },
    });
    return;
  }
  if (snapshot.activeTab === 'react' && snapshot.react.source === source) return;
  // For React, reset the previous run's diagnostics and bring the View back
  // to its placeholder so the Console/View panes don't keep showing stale
  // output while new code streams in. The iframe DOM itself is cleared by
  // ReactPanel's source-change effect.
  setSnapshot({
    ...snapshot,
    activeTab: 'react',
    react: {
      ...snapshot.react,
      source,
      compileErrors: [],
      runtimeErrors: [],
      resultGeneration: 0,
    },
  });
}

export function setLlmPreparingToolCall(
  next: { name: string | null } | null,
): void {
  const cur = snapshot.llm.preparingToolCall;
  if (cur === next) return;
  if (cur && next && cur.name === next.name) return;
  if (!cur && !next) return;
  setSnapshot({
    ...snapshot,
    llm: { ...snapshot.llm, preparingToolCall: next },
  });
}

export function setLocalLlmDownloadProgress(
  next: { label: string; pct: number; fromCache: boolean } | null,
): void {
  if (
    snapshot.llm.modelDownload?.label === next?.label &&
    snapshot.llm.modelDownload?.pct === next?.pct &&
    snapshot.llm.modelDownload?.fromCache === next?.fromCache
  ) {
    return;
  }
  setSnapshot({
    ...snapshot,
    llm: { ...snapshot.llm, modelDownload: next },
  });
}

/**
 * Reset the in-memory panel state but leave the persisted IndexedDB snapshot
 * alone. Used by the React cleanup hook so that dev hot-reloads don't wipe a
 * still-valid persisted snapshot.
 */
export function resetPanel(): void {
  revokePythonImages();
  setSnapshot(INITIAL_SNAPSHOT);
}

/**
 * Reset the Python, SQL, and React panes to their initial state, leaving the
 * Data pane (loaded tables) intact. Used by "New chat" to wipe tool execution
 * output without losing the user's data. The persisted snapshot is updated
 * via the usual `schedulePersist` path inside `setSnapshot`.
 */
export function clearNonDataPanes(): void {
  revokePythonImages();
  const activeTab: PaneKind =
    snapshot.activeTab === 'python' ||
    snapshot.activeTab === 'sql' ||
    snapshot.activeTab === 'react' ||
    snapshot.activeTab === 'subagents' ||
    snapshot.activeTab === 'file'
      ? 'data'
      : snapshot.activeTab;
  setSnapshot({
    ...snapshot,
    activeTab,
    python: INITIAL_PYTHON,
    sql: INITIAL_SQL,
    react: INITIAL_REACT,
    file: INITIAL_FILE,
  });
}

export function setRestoring(restoring: boolean): void {
  if (snapshot.restoring === restoring) return;
  // Bypass schedulePersist for the flag itself: it's session-only and
  // shouldn't trigger a write.
  snapshot = { ...snapshot, restoring };
  notify();
}

/**
 * Rehydrate the ExecutionPanel from IndexedDB on app startup. Stale `running`
 * / `pending` statuses are normalized to `idle` (the actual job died with the
 * old page), and image object URLs are recreated from the persisted PNG
 * bytes.
 */
export async function restorePanelFromIndexedDB(): Promise<void> {
  const persisted = await loadPanelSnapshot<PersistedPanelSnapshot>();
  if (!persisted) return;
  const normalize = (s: PaneStatus): PaneStatus =>
    s === 'running' || s === 'pending' ? 'idle' : s;
  const imageBytes = persisted.python.imageBytes ?? [];
  const images = imagesToObjectUrls(imageBytes);
  const persistedReact = persisted.react;
  setSnapshot({
    ...snapshot,
    activeTab: persisted.activeTab,
    python: {
      ...persisted.python,
      status: normalize(persisted.python.status),
      images,
      imageBytes,
    },
    sql: { ...persisted.sql, status: normalize(persisted.sql.status) },
    data: {
      ...persisted.data,
      status: normalize(persisted.data.status),
      // Default missing source on pre-tag snapshots; sandbox-tagged entries
      // from before the upgrade get mis-tagged as 'url' and survive the next
      // directory change, but the user can clear them manually.
      tables: persisted.data.tables.map((t) =>
        t.source ? t : { ...t, source: 'url' as const },
      ),
      pendingUrl: undefined,
      pendingTable: undefined,
    },
    react: persistedReact
      ? {
          ...persistedReact,
          status: normalize(persistedReact.status),
          // The live iframe doesn't survive a reload — force the View pane
          // to show "Re-run to render" by leaving generation at 0.
          resultGeneration: 0,
        }
      : INITIAL_REACT,
    file: { ...INITIAL_FILE, path: persisted.file?.path },
  });
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
