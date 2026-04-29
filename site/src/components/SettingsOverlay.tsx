import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import LLMSettingsSection from './LLMSettingsSection';
import SandboxSettingsSection from './SandboxSettingsSection';
import { CloseIcon } from './Icons';
import useLLMConfig from '../hooks/useLLMConfig';
import { LOCAL_GEMMA_ENDPOINT } from '../types/llm';
import { DEFAULT_LOCAL_GEMMA_ID, type LocalGemmaId } from '../lib/localLlm/models';

interface SettingsOverlayProps {
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
    width: 'min(760px, 92vw)',
    background: 'var(--white)',
    boxShadow: 'var(--el-4)',
    zIndex: 100,
    padding: '32px',
    overflowY: 'auto' as const,
    borderTopLeftRadius: 'var(--r-12)',
    borderBottomLeftRadius: 'var(--r-12)',
    borderLeft: '1px solid var(--mist)',
  } as const,
  topRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
    marginBottom: '20px',
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
};

export default function SettingsOverlay({ open, onClose }: SettingsOverlayProps) {
  const [mounted, setMounted] = useState<boolean>(false);
  const { config } = useLLMConfig();

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleClose = useCallback((): void => {
    if (config.activeEndpoint === LOCAL_GEMMA_ENDPOINT) {
      const modelId =
        (config.models[LOCAL_GEMMA_ENDPOINT] as LocalGemmaId | undefined) ??
        DEFAULT_LOCAL_GEMMA_ID;
      void (async () => {
        try {
          const { ensureLoaded } = await import('../lib/localLlm/llmService');
          await ensureLoaded(modelId);
        } catch (err) {
          console.error('Failed to load local Gemma model:', err);
        }
      })();
    }
    onClose();
  }, [config.activeEndpoint, config.models, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
    };
  }, [open, handleClose]);

  const backdropStyle: React.CSSProperties = {
    ...styles.backdrop,
    opacity: open ? 1 : 0,
    pointerEvents: open ? 'auto' : 'none',
  };

  const panelStyle: React.CSSProperties = {
    ...styles.panelBase,
    transform: open ? 'translateX(0)' : 'translateX(100%)',
    transition: open
      ? 'transform 300ms cubic-bezier(0, 0, 0.2, 1)'
      : 'transform 250ms cubic-bezier(0.4, 0, 1, 1)',
    pointerEvents: open ? 'auto' : 'none',
  };

  if (!mounted) return null;

  return createPortal(
    <>
      <div
        style={backdropStyle}
        onClick={handleClose}
        aria-hidden={!open}
      />
      <aside
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        aria-label="Settings"
      >
        <div style={styles.topRow}>
          <h2 style={styles.title}>Settings</h2>
          <button
            type="button"
            style={styles.closeButton}
            onClick={handleClose}
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
        <LLMSettingsSection />
        <SandboxSettingsSection />
      </aside>
    </>,
    document.body
  );
}
