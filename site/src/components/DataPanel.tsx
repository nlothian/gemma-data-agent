import { ChevronRightIcon, TrashIcon } from './Icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import useSandboxConfig, {
  useLoadedSandboxFiles,
} from '../hooks/useSandboxConfig';

import type { LoadedSandboxFile } from '../lib/sandboxFiles';
import type { LoadedTable } from '../lib/duckdb';
import {
  clearDataError,
  setDataPending,
  setDataResult,
  type PaneStatus,
} from '../lib/executionPanelStore';
import type { SandboxFileEntry } from '../lib/sandboxStore';
import SandboxSettingsSection from './SandboxSettingsSection';
import { clearAllInputs } from '../lib/duckdb';
import { invalidateAcrossCaches } from '../lib/cacheRegistry';

interface DataPanelProps {
  tables: LoadedTable[];
  status: PaneStatus;
  errorMessage?: string;
  pendingUrl?: string;
  pendingTable?: string;
}

export default function DataPanel({
  tables,
  status,
  errorMessage,
  pendingUrl,
  pendingTable,
}: DataPanelProps) {
  const { status: sandboxStatus } = useSandboxConfig();
  const [sandboxExpanded, setSandboxExpanded] = useState(
    sandboxStatus === 'unset',
  );
  const prevSandboxStatusRef = useRef(sandboxStatus);

  useEffect(() => {
    if (prevSandboxStatusRef.current !== 'unset' && sandboxStatus === 'unset') {
      setSandboxExpanded(true);
    }
    prevSandboxStatusRef.current = sandboxStatus;
  }, [sandboxStatus]);

  const isPending = status === 'pending' || status === 'running';
  const isCorsError =
    !!errorMessage && /Access-Control-Allow-Origin|CORS/i.test(errorMessage);

  const rest = (
    <>
      {isPending && (
        <div className="data-pending">
          <span className="exec-status-dot" data-status={status} aria-hidden />
          <span>
            Loading <code>{pendingTable ?? '?'}</code>
            {pendingUrl ? (
              <>
                {' '}from <span className="data-url">{pendingUrl}</span>
              </>
            ) : null}
            …
          </span>
        </div>
      )}

      {status === 'error' && errorMessage && (
        <div
          className="data-error"
          data-cors={isCorsError ? 'true' : undefined}
          role="alert"
        >
          <strong>{isCorsError ? 'CORS error' : 'Load failed'}</strong>
          <p>{errorMessage}</p>
          <DataClearButton label="Dismiss" onClick={clearDataError} />
        </div>
      )}

      {tables.length === 0 && !isPending && status !== 'error' && (
        <div className="data-empty">
          No data loaded. Ask the assistant to{' '}
          <code>LoadData(url, table_name)</code>.
        </div>
      )}

      {tables.length > 0 && (
        <>
          <div className="data-tables-header">
            <span>
              {tables.length} table{tables.length === 1 ? '' : 's'} loaded
            </span>
            <DataClearButton
              label="Clear all"
              onClick={() => void clearAllInputs()}
            />
          </div>
          <div className="data-tables">
            {tables.map((t) => (
              <TableCard key={t.name} table={t} />
            ))}
          </div>
        </>
      )}

      <SandboxFilesSection />
    </>
  );

  return (
    <div
      className="data-panel"
      data-sandbox-expanded={sandboxExpanded ? 'true' : 'false'}
      data-tour-id="exec.dataPanel"
      role="tabpanel"
    >
      <SandboxSettingsCollapsible
        expanded={sandboxExpanded}
        setExpanded={setSandboxExpanded}
      />
      {sandboxExpanded ? (
        <div className="data-panel-rest">{rest}</div>
      ) : (
        rest
      )}
    </div>
  );
}

function DataClearButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="data-clear-all" onClick={onClick}>
      <TrashIcon size={14} />
      <span>{label}</span>
    </button>
  );
}

function SandboxSettingsCollapsible({
  expanded,
  setExpanded,
}: {
  expanded: boolean;
  setExpanded: (updater: (prev: boolean) => boolean) => void;
}) {
  return (
    <article className="data-table-card">
      <header className="data-table-head">
        <button
          type="button"
          className="data-table-toggle"
          data-expanded={expanded ? 'true' : 'false'}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <ChevronRightIcon size={14} />
          <h3>Sandbox Settings</h3>
        </button>
      </header>
      {expanded && (
        <div style={{ paddingLeft: '22px', paddingRight: '22px', paddingBottom: '22px' }}>
          <SandboxSettingsSection />
        </div>
      )}
    </article>
  );
}

function TableCard({ table }: { table: LoadedTable }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article className="data-table-card">
      <header className="data-table-head">
        <button
          type="button"
          className="data-table-toggle"
          data-expanded={expanded ? 'true' : 'false'}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <ChevronRightIcon size={14} />
          <h3>
            <code>{table.name}</code>
          </h3>
          {table.source === 'python' && (
            <span
              className="data-table-source-tag"
              title="Produced by RunPython, not a loaded file/URL"
            >
              computed
            </span>
          )}
          <span className="data-table-meta">
            {table.format} · {formatRowCount(table.rowCount)} rows
          </span>
        </button>
        <button
          type="button"
          className="data-table-clear"
          aria-label={`Clear ${table.name}`}
          title={`Clear ${table.name}`}
          onClick={(e) => {
            e.stopPropagation();
            void invalidateAcrossCaches((m) => m.name === table.name);
          }}
        >
          <TrashIcon size={14} />
        </button>
      </header>
      {expanded && (
        <>
          <div className="data-table-url" title={table.url}>
            {table.url}
          </div>
          <table className="data-schema">
            <thead>
              <tr>
                <th>column</th>
                <th>type</th>
              </tr>
            </thead>
            <tbody>
              {table.schema.map((col) => (
                <tr key={col.name}>
                  <td>
                    <code>{col.name}</code>
                  </td>
                  <td>
                    <code>{col.type}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </article>
  );
}

function SandboxFilesSection() {
  const { status, directoryName, files, reAuthorise } = useSandboxConfig();
  const loaded = useLoadedSandboxFiles();
  const loadedByPath = useMemo(
    () => new Map(loaded.map((f) => [f.relativePath, f])),
    [loaded],
  );
  const groups = useMemo(() => groupFilesByDir(files), [files]);

  if (status === 'loading' || status === 'unsupported') return null;

  if (status === 'unset') {
    return (
      <div className="sandbox-empty">
        Pick a sandbox directory in Settings to enable local files.
      </div>
    );
  }

  if (status === 'permission-denied') {
    return (
      <div className="sandbox-permission-banner" role="alert">
        <strong>Permission denied</strong>
        <p>
          Access to <code>{directoryName ?? '?'}</code> needs to be re-granted
          before files can be listed or loaded.
        </p>
        <button type="button" onClick={() => void reAuthorise()}>
          Re-authorise
        </button>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="sandbox-empty">
        No supported files in <code>{directoryName ?? '?'}</code>.
      </div>
    );
  }

  return (
    <section className="sandbox-files">
      <header className="sandbox-files-header">
        <h3>Files ({files.length})</h3>
        <span className="sandbox-dir">{directoryName}</span>
      </header>
      {groups.map((group) => (
        <div className="sandbox-files-group" key={group.dir || '/'}>
          <div className="sandbox-files-group-label">
            {group.dir ? group.dir + '/' : './'}
          </div>
          {group.files.map((f) => (
            <FileRow
              key={f.relativePath}
              file={f}
              loaded={loadedByPath.get(f.relativePath)}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

function FileRow({
  file,
  loaded,
}: {
  file: SandboxFileEntry;
  loaded?: LoadedSandboxFile;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLoad = async () => {
    const registerAs = deriveRegisterName(file);
    setBusy(true);
    setError(null);
    // Go through the exact path the agent's LoadData tool uses so all three
    // stores stay in sync: runLoadDataLocal writes duckdb + the sandboxFiles
    // registry (→ the per-row badge), and setDataResult writes the panel's
    // table list (→ the "N tables loaded" header). Calling loadSandboxFile
    // directly would update the badge but leave the panel saying "No data
    // loaded".
    setDataPending(registerAs, file.relativePath);
    try {
      const { runLoadDataLocal } = await import('../lib/agentTools');
      const res = await runLoadDataLocal(file.relativePath, registerAs);
      setDataResult(res);
      if ('error' in res) setError(res.error);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setDataResult({ error: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sandbox-file-row" title={file.relativePath}>
      <span className="sandbox-file-name">{file.name}</span>
      <span className="sandbox-file-ext">{file.ext}</span>
      <span className="sandbox-file-size">{formatSize(file.sizeBytes)}</span>
      {loaded ? (
        <span
          className="sandbox-file-loaded-badge"
          title={loaded.tableName ? `Table: ${loaded.tableName}` : 'Loaded'}
        >
          {loaded.tableName ? `→ ${loaded.tableName}` : 'loaded'}
        </span>
      ) : (
        <button
          type="button"
          className="sandbox-file-load-btn"
          data-error={error ? 'true' : undefined}
          disabled={busy}
          onClick={() => void onLoad()}
          title={
            error ?? `Load as ${deriveRegisterName(file)}`
          }
        >
          {busy ? 'Loading…' : error ? 'Retry' : 'Load'}
        </button>
      )}
    </div>
  );
}

/**
 * Derive a DuckDB-/registry-safe name from a sandbox file: the filename stem
 * with every char outside `[A-Za-z0-9_]` replaced, prefixed if it would
 * otherwise start with a digit. Matches the `[A-Za-z_][A-Za-z0-9_]*` rule
 * `registerAndLoadBuffer` enforces.
 */
function deriveRegisterName(file: SandboxFileEntry): string {
  const stem =
    file.name.slice(0, file.name.length - file.ext.length - 1) || file.name;
  const cleaned = stem.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `_${cleaned}`;
}

function groupFilesByDir(
  files: SandboxFileEntry[],
): { dir: string; files: SandboxFileEntry[] }[] {
  const map = new Map<string, SandboxFileEntry[]>();
  for (const f of files) {
    const slash = f.relativePath.lastIndexOf('/');
    const dir = slash < 0 ? '' : f.relativePath.slice(0, slash);
    const list = map.get(dir);
    if (list) {
      list.push(f);
    } else {
      map.set(dir, [f]);
    }
  }
  return Array.from(map, ([dir, files]) => ({ dir, files })).sort((a, b) =>
    a.dir.localeCompare(b.dir),
  );
}

function formatRowCount(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}
