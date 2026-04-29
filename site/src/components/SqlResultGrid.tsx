import type { TabularResult } from '../lib/duckdb';

interface SqlResultGridProps {
  tabular?: TabularResult;
  errorMessage?: string;
  status: 'idle' | 'pending' | 'running' | 'done' | 'error' | 'aborted';
}

const MAX_CELL_LEN = 200;

export default function SqlResultGrid({
  tabular,
  errorMessage,
  status,
}: SqlResultGridProps) {
  if (errorMessage) {
    return (
      <div className="exec-grid-wrap">
        <div className="exec-error-block">{errorMessage}</div>
      </div>
    );
  }

  if (!tabular) {
    return (
      <div className="exec-grid-wrap">
        <div className="exec-output-placeholder exec-grid-placeholder">
          {placeholderFor(status)}
        </div>
      </div>
    );
  }

  const { columns, rows, truncated } = tabular;

  if (columns.length === 0 && rows.length === 0) {
    return (
      <div className="exec-grid-wrap">
        <div className="exec-output-placeholder exec-grid-placeholder">
          (empty result)
        </div>
      </div>
    );
  }

  return (
    <div className="exec-grid-wrap">
      <table className="exec-grid">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {columns.map((_, c) => (
                <td key={c}>{formatCell(row[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="exec-grid-footer">
        {truncated
          ? `Showing first ${rows.length.toLocaleString()} rows (result truncated — add a LIMIT or filter to see more)`
          : `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}`}
      </div>
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return truncate(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  try {
    return truncate(JSON.stringify(v));
  } catch {
    return truncate(String(v));
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_CELL_LEN) return s;
  return s.slice(0, MAX_CELL_LEN) + '…';
}

function placeholderFor(status: SqlResultGridProps['status']): string {
  switch (status) {
    case 'pending':
      return 'Awaiting Step / Play to execute…';
    case 'running':
      return 'Running…';
    case 'aborted':
      return 'Aborted before execution.';
    default:
      return 'Run a SQL tool call to see results here.';
  }
}
