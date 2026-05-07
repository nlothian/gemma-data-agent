import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './Icons';
import SourcecodeSearchPane from './SourcecodeSearchPane';
import SourcecodeResultsList from './SourcecodeResultsList';
import {
  ensureSourcecodeReady,
  getSyncStatus,
  subscribeSyncStatus,
} from '../lib/sourcecode/syncStore';
import type { SyncStatus } from '../lib/sourcecode/types';
import {
  clearOpenFile,
  getOpenFile,
  getServerOpenFile,
  setOpenFile,
  subscribeOpenFile,
  type OpenFileTarget,
} from '../lib/sourcecode/openFileStore';

export type { OpenFileTarget };

const SourcecodeFileViewer = lazy(() => import('./SourcecodeFileViewer'));

interface SourcecodeOverlayProps {
  open: boolean;
  onClose: () => void;
}

const styles = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(15, 20, 25, 0.32)',
    transition: 'opacity 200ms ease',
    zIndex: 90,
  } as const,
  panelBase: {
    position: 'fixed' as const,
    top: 0,
    right: 0,
    bottom: 0,
    width: 'min(960px, 95vw)',
    background: 'var(--white)',
    boxShadow: 'var(--el-4)',
    zIndex: 100,
    padding: '32px',
    overflowY: 'auto' as const,
    borderTopLeftRadius: 'var(--r-12)',
    borderBottomLeftRadius: 'var(--r-12)',
    borderLeft: '1px solid var(--mist)',
    display: 'flex' as const,
    flexDirection: 'column' as const,
    gap: '16px',
  } as const,
  topRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    paddingBottom: '16px',
    borderBottom: '1px solid var(--mist)',
  } as const,
  title: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 300,
    fontSize: '28px',
    lineHeight: 1.2,
    letterSpacing: '-0.02em',
    color: 'var(--ink)',
    margin: 0,
  } as const,
  closeButton: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '13px',
    letterSpacing: '-0.005em',
    color: 'var(--graphite)',
    background: 'var(--gel-white)',
    border: '1px solid var(--mist)',
    padding: '8px 12px',
    borderRadius: 'var(--r-8)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'border-color 150ms ease, color 150ms ease',
    boxShadow: 'var(--el-1), var(--inner-gloss)',
  } as const,
  syncBanner: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--graphite)',
    background: 'var(--gel-white)',
    border: '1px solid var(--mist)',
    borderRadius: 'var(--r-8)',
    padding: '8px 12px',
  } as const,
};

/**
 * Pure style builders for the closed/open states. Exported so the
 * regression test in `__tests__/SourcecodeOverlay.styles.test.ts` can
 * assert that, when closed, the overlay is fully off-screen and
 * non-interactive — i.e. it can never visually cover the menu bar or
 * the main content (e.g. the execution panel tabs).
 */
export function buildBackdropStyle(open: boolean): React.CSSProperties {
  return {
    ...styles.backdrop,
    opacity: open ? 1 : 0,
    pointerEvents: open ? 'auto' : 'none',
  };
}

export function buildPanelStyle(open: boolean): React.CSSProperties {
  return {
    ...styles.panelBase,
    transform: open ? 'translateX(0)' : 'translateX(100%)',
    transition: open
      ? 'transform 300ms cubic-bezier(0, 0, 0.2, 1)'
      : 'transform 250ms cubic-bezier(0.4, 0, 1, 1)',
    pointerEvents: open ? 'auto' : 'none',
  };
}

function syncLabel(status: SyncStatus): string | null {
  if (status.phase === 'ready') return null;
  if (status.phase === 'idle') return 'Preparing sources…';
  if (status.phase === 'checking') return 'Checking for updates…';
  if (status.phase === 'error') return `Sync error: ${status.error ?? 'unknown'}`;
  const verb = status.phase === 'fetching' ? 'Fetching' : 'Unzipping';
  if (status.progress && status.progress.total > 0) {
    const pct = Math.floor((status.progress.done / status.progress.total) * 100);
    return `${verb} sources… ${pct}%`;
  }
  return `${verb} sources…`;
}

export default function SourcecodeOverlay({ open, onClose }: SourcecodeOverlayProps): JSX.Element | null {
  const [mounted, setMounted] = useState<boolean>(false);
  const openFile = useSyncExternalStore(subscribeOpenFile, getOpenFile, getServerOpenFile);
  const syncStatus = useSyncExternalStore(subscribeSyncStatus, getSyncStatus, getSyncStatus);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    void ensureSourcecodeReady().catch(() => {
      // sync errors are surfaced via the syncStatus banner; swallow rejection
    });
  }, [open]);

  // When the overlay closes, drop the open-file target so the next open
  // lands on the search view (mirrors pre-store local-useState behaviour).
  useEffect(() => {
    if (!open) clearOpenFile();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [open, onClose]);

  const backdropStyle = buildBackdropStyle(open);
  const panelStyle = buildPanelStyle(open);

  if (!mounted) return null;

  const banner = syncLabel(syncStatus);

  return createPortal(
    <>
      <div style={backdropStyle} onClick={onClose} aria-hidden={!open} />
      <aside
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        aria-label="Sourcecode"
      >
        <div style={styles.topRow}>
          <h2 style={styles.title}>Sourcecode</h2>
          <button
            type="button"
            style={styles.closeButton}
            onClick={onClose}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--silver)';
              e.currentTarget.style.color = 'var(--ink)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--mist)';
              e.currentTarget.style.color = 'var(--graphite)';
            }}
          >
            <CloseIcon size={14} />
            Close
          </button>
        </div>
        {banner ? <div style={styles.syncBanner}>{banner}</div> : null}
        {openFile ? (
          <Suspense fallback={<div style={styles.syncBanner}>Loading viewer…</div>}>
            <SourcecodeFileViewer file={openFile} onBack={clearOpenFile} />
          </Suspense>
        ) : (
          <>
            <SourcecodeSearchPane onOpenFile={setOpenFile} />
            <SourcecodeResultsList onOpenFile={setOpenFile} />
          </>
        )}
      </aside>
    </>,
    document.body,
  );
}
