import { openSourcecode } from '../lib/sourcecode/uiStore';

export default function SourcecodeMenuButton(): JSX.Element {
  const onClick = (): void => {
    openSourcecode();
  };

  const style: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    padding: 0,
    margin: 0,
    font: 'inherit',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
    color: 'var(--steel)',
    cursor: 'pointer',
  };

  return (
    <button
      type="button"
      onClick={onClick}
      style={style}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'var(--aqua-500)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'var(--steel)';
      }}
    >
      Sourcecode
    </button>
  );
}
