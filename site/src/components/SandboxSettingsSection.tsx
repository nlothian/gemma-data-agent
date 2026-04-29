import useSandboxConfig from '../hooks/useSandboxConfig';

const styles = {
  wrapper: {
    marginTop: '24px',
  } as const,
  sectionHeading: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
    fontSize: '11px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.12em',
    color: 'var(--aqua-700)',
    margin: '0 0 8px',
  } as const,
  caption: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 400,
    fontSize: '14px',
    lineHeight: 1.55,
    color: 'var(--steel)',
    margin: '0 0 16px',
  } as const,
  card: {
    border: '1px solid var(--mist)',
    borderRadius: 'var(--r-8)',
    background: 'var(--white)',
    padding: '14px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  } as const,
  status: {
    fontFamily: 'var(--font-sans)',
    fontSize: '13px',
    color: 'var(--ink)',
    margin: 0,
  } as const,
  pathName: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
    color: 'var(--ink)',
  } as const,
  meta: {
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
    color: 'var(--steel)',
    margin: 0,
  } as const,
  actions: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap' as const,
  } as const,
  primaryButton: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '12px',
    color: 'var(--white)',
    background: 'var(--aqua-600)',
    border: '1px solid var(--aqua-600)',
    padding: '6px 12px',
    borderRadius: 'var(--r-8)',
    cursor: 'pointer',
  } as const,
  secondaryButton: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '12px',
    color: 'var(--graphite)',
    background: 'var(--white)',
    border: '1px solid var(--silver)',
    padding: '6px 12px',
    borderRadius: 'var(--r-8)',
    cursor: 'pointer',
  } as const,
  dangerButton: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '12px',
    color: 'var(--rust-700, #a23a18)',
    background: 'var(--white)',
    border: '1px solid var(--silver)',
    padding: '6px 12px',
    borderRadius: 'var(--r-8)',
    cursor: 'pointer',
  } as const,
  warning: {
    fontFamily: 'var(--font-sans)',
    fontSize: '13px',
    color: 'var(--rust-700, #a23a18)',
    margin: 0,
  } as const,
  unsupported: {
    fontFamily: 'var(--font-sans)',
    fontSize: '13px',
    color: 'var(--steel)',
    fontStyle: 'italic' as const,
    margin: 0,
  } as const,
};

export default function SandboxSettingsSection() {
  const {
    status,
    directoryName,
    files,
    chooseDirectory,
    reAuthorise,
    refreshFiles,
    clearDirectory,
  } = useSandboxConfig();

  return (
    <section style={styles.wrapper}>
      <h3 style={styles.sectionHeading}>Sandbox</h3>
      <p style={styles.caption}>
        Pick a local directory to make its files available to the assistant.
        Files stay on your machine — only your browser reads them.
      </p>
      <div style={styles.card}>
        {status === 'loading' && (
          <p style={styles.meta}>Checking saved sandbox…</p>
        )}

        {status === 'unsupported' && (
          <p style={styles.unsupported}>
            Your browser does not support the File System Access API. Try a
            Chromium-based browser (Chrome, Edge, Brave).
          </p>
        )}

        {status === 'unset' && (
          <>
            <p style={styles.status}>No directory selected.</p>
            <div style={styles.actions}>
              <button
                type="button"
                style={styles.primaryButton}
                onClick={() => void chooseDirectory()}
              >
                Choose directory…
              </button>
            </div>
          </>
        )}

        {status === 'permitted' && (
          <>
            <p style={styles.status}>
              Selected: <span style={styles.pathName}>{directoryName ?? '?'}</span>{' '}
              <span style={styles.meta}>
                ({files.length} {files.length === 1 ? 'file' : 'files'})
              </span>
            </p>
            <div style={styles.actions}>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() => void chooseDirectory()}
              >
                Change…
              </button>
              <button
                type="button"
                style={styles.secondaryButton}
                onClick={() => void refreshFiles()}
              >
                Refresh
              </button>
              <button
                type="button"
                style={styles.dangerButton}
                onClick={() => void clearDirectory()}
              >
                Clear
              </button>
            </div>
          </>
        )}

        {status === 'permission-denied' && (
          <>
            <p style={styles.warning}>
              Permission required for{' '}
              <span style={styles.pathName}>{directoryName ?? '?'}</span>.
            </p>
            <div style={styles.actions}>
              <button
                type="button"
                style={styles.primaryButton}
                onClick={() => void reAuthorise()}
              >
                Re-authorise
              </button>
              <button
                type="button"
                style={styles.dangerButton}
                onClick={() => void clearDirectory()}
              >
                Clear
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
