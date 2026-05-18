import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { CloseIcon } from './Icons';
import { detectWebGpu } from '../lib/localLlm/webgpu';

/**
 * LiteRT/MediaPipe loads the Gemma weights into a single GPU storage buffer.
 * Browsers that cap `maxBufferSize` below the model size cannot run the agent
 * at all — Firefox currently pins this at exactly 1 GiB, while Chrome exposes
 * the full adapter limit (typically several GB).
 *
 * 2.5 GB is the documented floor for the agent to work. Tune this single
 * constant if the requirement changes.
 */
const REQUIRED_MAX_BUFFER_BYTES = 2.5 * 1024 ** 3;
const REQUIRED_LABEL = '2.5 GB';

// Above the tour overlay (SpotlightOverlay svg z 80, tour card z 84) and the
// compaction preview (z 95) so a "this browser can't run the app" warning is
// never obscured by app chrome.
const BANNER_Z_INDEX = 2000;

function formatGiB(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || bytes <= 0) return 'none';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Full-width bar warning that the current browser's WebGPU buffer limit is
 * too small to run Gemma Data Agent. Renders nothing until WebGPU detection
 * resolves, and nothing when the adapter reports a large enough buffer.
 */
export default function GpuBufferWarningBanner(): JSX.Element | null {
  const [maxBufferSize, setMaxBufferSize] = useState<number | undefined>(undefined);
  const [resolved, setResolved] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    detectWebGpu().then((status) => {
      if (cancelled) return;
      setMaxBufferSize(status.maxBufferSize);
      setResolved(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Don't flash the banner before detection completes.
  if (!resolved) return null;
  if (dismissed) return null;

  const ok =
    typeof maxBufferSize === 'number' && maxBufferSize >= REQUIRED_MAX_BUFFER_BYTES;
  if (ok) return null;

  if (typeof document === 'undefined') return null;

  const barStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    zIndex: BANNER_Z_INDEX,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--s-3, 12px)',
    // Extra right padding so the centred message never runs under the
    // absolutely-positioned close button.
    padding: 'var(--s-3, 12px) calc(var(--s-4, 16px) + 36px)',
    background: 'var(--danger-500, #e53935)',
    color: '#fff',
    fontFamily: 'var(--font-sans)',
    fontSize: '14px',
    lineHeight: 1.5,
    textAlign: 'center',
    boxShadow: 'var(--el-2, 0 2px 4px rgba(15, 20, 25, 0.05))',
    pointerEvents: 'auto',
  };

  return createPortal(
    <div style={barStyle} role="alert">
      <span aria-hidden="true" style={{ fontSize: '16px' }}>
        ⚠
      </span>
      <span>
        <strong>Gemma Data Agent won&rsquo;t run in this browser.</strong> It
        needs a GPU buffer of at least {REQUIRED_LABEL}; this browser caps it at{' '}
        {formatGiB(maxBufferSize)}. Use Google Chrome, which supports this.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        title="Dismiss"
        style={{
          position: 'absolute',
          top: '50%',
          right: 'var(--s-3, 12px)',
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 4,
          border: 'none',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          borderRadius: 6,
          lineHeight: 0,
        }}
      >
        <CloseIcon size={20} />
      </button>
    </div>,
    document.body,
  );
}
