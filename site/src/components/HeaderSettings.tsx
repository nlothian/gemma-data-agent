import { useState } from 'react';
import SettingsOverlay from './SettingsOverlay';
import { SettingsIcon } from './Icons';

const buttonStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  letterSpacing: '0.02em',
  textTransform: 'uppercase',
  fontWeight: 500,
  color: 'var(--steel)',
  background: 'transparent',
  border: '1px solid var(--mist)',
  borderRadius: 'var(--r-8)',
  padding: '6px 12px',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  transition: 'color 120ms ease, border-color 120ms ease, background 120ms ease',
};

export default function HeaderSettings() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        style={buttonStyle}
        onClick={() => setOpen(true)}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--aqua-600)';
          e.currentTarget.style.borderColor = 'var(--silver)';
          e.currentTarget.style.background = 'var(--white)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = 'var(--steel)';
          e.currentTarget.style.borderColor = 'var(--mist)';
          e.currentTarget.style.background = 'transparent';
        }}
        aria-label="Open settings"
      >
        <SettingsIcon size={14} />
        Settings
      </button>
      <SettingsOverlay open={open} onClose={() => setOpen(false)} />
    </>
  );
}
