import { useSyncExternalStore } from 'react';
import { getSearchSnapshot, subscribeSearch } from '../lib/sourcecode/searchPool';
import type { SearchResult } from '../lib/sourcecode/types';
import type { OpenFileTarget } from '../lib/sourcecode/openFileStore';

interface SourcecodeResultsListProps {
  onOpenFile: (target: OpenFileTarget) => void;
}

const MAX_RENDER = 1000;

const styles = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
    minHeight: 0,
    flex: 1,
  } as const,
  chip: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--graphite)',
    background: 'var(--gel-white)',
    border: '1px solid var(--mist)',
    borderRadius: 'var(--r-8)',
    padding: '6px 10px',
    alignSelf: 'flex-start',
  } as const,
  list: {
    listStyle: 'none' as const,
    margin: 0,
    padding: 0,
    border: '1px solid var(--mist)',
    borderRadius: 'var(--r-8)',
    background: 'var(--white)',
    overflowY: 'auto' as const,
    maxHeight: '60vh',
  } as const,
  row: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    padding: '8px 12px',
    cursor: 'pointer',
    width: '100%',
    background: 'var(--white)',
    border: 'none',
    borderBottom: '1px solid var(--mist)',
    textAlign: 'left' as const,
    color: 'inherit',
    fontFamily: 'var(--font-mono)',
    fontSize: 'inherit',
  } as const,
  rowMeta: {
    fontSize: '12px',
    color: 'var(--graphite)',
  } as const,
  rowText: {
    fontSize: '13px',
    color: 'var(--ink)',
    whiteSpace: 'pre' as const,
    overflow: 'hidden' as const,
    textOverflow: 'ellipsis' as const,
  } as const,
  mark: {
    background: 'var(--aqua-500)',
    color: 'var(--white)',
    padding: '0 1px',
    borderRadius: '2px',
  } as const,
  emptyState: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--graphite)',
    padding: '16px',
    textAlign: 'center' as const,
  } as const,
};

function renderLineWithMatch(result: SearchResult): JSX.Element {
  const { lineText, matchStart, matchEnd } = result;
  const safeStart = Math.max(0, Math.min(matchStart, lineText.length));
  const safeEnd = Math.max(safeStart, Math.min(matchEnd, lineText.length));
  const before = lineText.slice(0, safeStart);
  const match = lineText.slice(safeStart, safeEnd);
  const after = lineText.slice(safeEnd);
  return (
    <>
      {before}
      <mark style={styles.mark}>{match}</mark>
      {after}
    </>
  );
}

export default function SourcecodeResultsList({
  onOpenFile,
}: SourcecodeResultsListProps): JSX.Element {
  const snapshot = useSyncExternalStore(subscribeSearch, getSearchSnapshot, getSearchSnapshot);
  const total = snapshot.results.length;
  const visible = snapshot.results.slice(0, MAX_RENDER);
  const truncated = total > MAX_RENDER;
  const timeoutCount = snapshot.timeouts.length;

  return (
    <div style={styles.wrapper}>
      {timeoutCount > 0 ? (
        <div style={styles.chip}>
          {timeoutCount} file{timeoutCount === 1 ? '' : 's'} skipped (regex too slow)
        </div>
      ) : null}
      {truncated ? (
        <div style={styles.chip}>
          Showing first {MAX_RENDER} of {total}
        </div>
      ) : null}
      <ul style={styles.list}>
        {visible.length === 0 ? (
          <li style={styles.emptyState}>
            {snapshot.state.phase === 'searching' ? 'Searching…' : 'No results'}
          </li>
        ) : (
          visible.map((r, i) => (
            <li key={`${r.path}:${r.line}:${r.col}:${i}`} style={{ listStyle: 'none' }}>
              <button
                type="button"
                style={styles.row}
                onClick={() =>
                  onOpenFile({
                    kind: 'match',
                    path: r.path,
                    line: r.line,
                    matchStart: r.matchStart,
                    matchEnd: r.matchEnd,
                  })
                }
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--gel-white)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--white)';
                }}
              >
                <span style={styles.rowMeta}>
                  {r.path}:{r.line}:{r.col}
                </span>
                <span style={styles.rowText}>{renderLineWithMatch(r)}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
