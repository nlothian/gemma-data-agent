import type { LoadedTable } from '../lib/duckdb';
import type { PaneStatus } from '../lib/executionPanelStore';

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
  const isPending = status === 'pending' || status === 'running';
  const isCorsError =
    !!errorMessage && /Access-Control-Allow-Origin|CORS/i.test(errorMessage);

  return (
    <div className="data-panel" role="tabpanel">
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
        </div>
      )}

      {tables.length === 0 && !isPending && status !== 'error' && (
        <div className="data-empty">
          No data loaded. Ask the assistant to{' '}
          <code>LoadData(url, table_name)</code>.
        </div>
      )}

      {tables.length > 0 && (
        <div className="data-tables">
          {tables.map((t) => (
            <TableCard key={t.name} table={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TableCard({ table }: { table: LoadedTable }) {
  return (
    <article className="data-table-card">
      <header className="data-table-head">
        <h3>
          <code>{table.name}</code>
        </h3>
        <span className="data-table-meta">
          {table.format} · {formatRowCount(table.rowCount)} rows
        </span>
      </header>
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
    </article>
  );
}

function formatRowCount(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toLocaleString();
}
