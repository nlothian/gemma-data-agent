import { useState, useSyncExternalStore } from 'react';
import {
  cancelSearch,
  getSearchSnapshot,
  startSearch,
  subscribeSearch,
} from '../lib/sourcecode/searchPool';
import { getSyncStatus, subscribeSyncStatus } from '../lib/sourcecode/syncStore';
import type { OpenFileTarget } from '../lib/sourcecode/openFileStore';

interface SourcecodeSearchPaneProps {
  // Kept for seam parity with SourcecodeResultsList; unused in this pane.
  onOpenFile?: (target: OpenFileTarget) => void;
}

const styles = {
  wrapper: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '10px',
  } as const,
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    color: 'var(--ink)',
    background: 'var(--white)',
    border: '1px solid var(--mist)',
    borderRadius: 'var(--r-8)',
    padding: '10px 12px',
    outline: 'none',
    boxShadow: 'var(--inner-gloss)',
  } as const,
  controlsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap' as const,
  } as const,
  flagsGroup: {
    display: 'inline-flex',
    gap: '6px',
    marginRight: 'auto',
  } as const,
  flagChip: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    padding: '6px 10px',
    border: '1px solid var(--mist)',
    borderRadius: 'var(--r-8)',
    cursor: 'pointer',
    background: 'var(--gel-white)',
    color: 'var(--graphite)',
    userSelect: 'none' as const,
  } as const,
  flagChipActive: {
    background: 'var(--aqua-500)',
    color: 'var(--white)',
    borderColor: 'var(--aqua-500)',
  } as const,
  primaryButton: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '13px',
    color: 'var(--white)',
    background: 'var(--aqua-500)',
    border: '1px solid var(--aqua-500)',
    padding: '8px 14px',
    borderRadius: 'var(--r-8)',
    cursor: 'pointer',
    boxShadow: 'var(--el-1), var(--inner-gloss)',
  } as const,
  primaryButtonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed' as const,
  } as const,
  secondaryButton: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '13px',
    color: 'var(--graphite)',
    background: 'var(--gel-white)',
    border: '1px solid var(--mist)',
    padding: '8px 14px',
    borderRadius: 'var(--r-8)',
    cursor: 'pointer',
  } as const,
  status: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--graphite)',
  } as const,
  errorStatus: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: '#b3261e',
  } as const,
};

export default function SourcecodeSearchPane(_props: SourcecodeSearchPaneProps): JSX.Element {
  const [pattern, setPattern] = useState<string>('');
  const [flagI, setFlagI] = useState<boolean>(true);
  const [flagM, setFlagM] = useState<boolean>(false);

  const searchSnapshot = useSyncExternalStore(
    subscribeSearch,
    getSearchSnapshot,
    getSearchSnapshot,
  );
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);

  const ready = syncStatus.phase === 'ready';
  const searching = searchSnapshot.state.phase === 'searching';

  const submit = (): void => {
    if (!pattern.trim() || !ready || searching) return;
    let flagsString = '';
    if (flagI) flagsString += 'i';
    if (flagM) flagsString += 'm';
    startSearch(pattern, flagsString);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  };

  const searchDisabled = !ready || searching || !pattern.trim();

  return (
    <div style={styles.wrapper}>
      <input
        type="text"
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Regex pattern…"
        style={styles.input}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      <div style={styles.controlsRow}>
        <div style={styles.flagsGroup} role="group" aria-label="Regex flags">
          <button
            type="button"
            aria-pressed={flagI}
            onClick={() => setFlagI((v) => !v)}
            style={{
              ...styles.flagChip,
              ...(flagI ? styles.flagChipActive : {}),
            }}
            title="Case-insensitive"
          >
            i
          </button>
          <button
            type="button"
            aria-pressed={flagM}
            onClick={() => setFlagM((v) => !v)}
            style={{
              ...styles.flagChip,
              ...(flagM ? styles.flagChipActive : {}),
            }}
            title="Multiline (^/$ match line bounds)"
          >
            m
          </button>
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={searchDisabled}
          style={{
            ...styles.primaryButton,
            ...(searchDisabled ? styles.primaryButtonDisabled : {}),
          }}
        >
          Search
        </button>
        {searching ? (
          <button
            type="button"
            onClick={() => cancelSearch()}
            style={styles.secondaryButton}
          >
            Cancel
          </button>
        ) : null}
      </div>
      {searchSnapshot.state.phase === 'searching' ? (
        <div style={styles.status}>
          Searching… ({searchSnapshot.state.done}/{searchSnapshot.state.total})
        </div>
      ) : null}
      {searchSnapshot.state.phase === 'error' ? (
        <div style={styles.errorStatus}>Error: {searchSnapshot.state.message}</div>
      ) : null}
      {searchSnapshot.state.phase === 'cancelled' ? (
        <div style={styles.status}>Search cancelled.</div>
      ) : null}
    </div>
  );
}
