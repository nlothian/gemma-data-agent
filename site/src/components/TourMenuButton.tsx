import { startTour } from '../lib/tour/controller';
import { DEFAULT_TOUR } from '../lib/tour/stages';

export default function TourMenuButton(): JSX.Element {
  const onClick = (): void => {
    if (window.location.pathname === '/') {
      startTour(DEFAULT_TOUR);
      return;
    }
    localStorage.setItem('tour.autostart', '1');
    window.location.href = '/';
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
      Tour
    </button>
  );
}
