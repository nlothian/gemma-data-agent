import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import SpotlightOverlay, { type SpotlightRect } from './SpotlightOverlay';
import {
  end,
  getActiveDefinition,
  getServerSnapshot,
  getSnapshot,
  next,
  startTour,
  subscribe,
} from '../lib/tour/controller';
import { DEFAULT_TOUR } from '../lib/tour/stages';
import type { TourStage } from '../lib/tour/types';

interface UnionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CARD_WIDTH = 320;
const CARD_PADDING = 16;
const CARD_GAP = 16;
const MIN_FREE_W = 280;
const MIN_FREE_H = 140;

type Side = 'right' | 'below' | 'left' | 'above' | 'centred-bottom';

interface CardPosition {
  left: number;
  top: number;
  side: Side;
}

function unionOf(rects: SpotlightRect[]): UnionRect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    if (r.x < x0) x0 = r.x;
    if (r.y < y0) y0 = r.y;
    if (r.x + r.w > x1) x1 = r.x + r.w;
    if (r.y + r.h > y1) y1 = r.y + r.h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function chooseSide(
  u: UnionRect,
  cardH: number,
  vw: number,
  vh: number,
): CardPosition {
  const margin = CARD_GAP;
  const safe = 8;

  const rightFreeW = vw - (u.x + u.w) - margin - safe;
  const leftFreeW = u.x - margin - safe;
  const belowFreeH = vh - (u.y + u.h) - margin - safe;
  const aboveFreeH = u.y - margin - safe;

  const rightOk = rightFreeW >= MIN_FREE_W && vh - 2 * safe >= MIN_FREE_H;
  const belowOk = belowFreeH >= MIN_FREE_H && vw - 2 * safe >= MIN_FREE_W;
  const leftOk = leftFreeW >= MIN_FREE_W && vh - 2 * safe >= MIN_FREE_H;
  const aboveOk = aboveFreeH >= MIN_FREE_H && vw - 2 * safe >= MIN_FREE_W;

  if (rightOk) {
    const left = u.x + u.w + margin;
    const top = clamp(u.y + u.h / 2 - cardH / 2, safe, vh - cardH - safe);
    return { left, top, side: 'right' };
  }
  if (belowOk) {
    const top = u.y + u.h + margin;
    const left = clamp(
      u.x + u.w / 2 - CARD_WIDTH / 2,
      safe,
      vw - CARD_WIDTH - safe,
    );
    return { left, top, side: 'below' };
  }
  if (leftOk) {
    const left = u.x - margin - CARD_WIDTH;
    const top = clamp(u.y + u.h / 2 - cardH / 2, safe, vh - cardH - safe);
    return { left, top, side: 'left' };
  }
  if (aboveOk) {
    const top = u.y - margin - cardH;
    const left = clamp(
      u.x + u.w / 2 - CARD_WIDTH / 2,
      safe,
      vw - CARD_WIDTH - safe,
    );
    return { left, top, side: 'above' };
  }
  // Fallback — centred at the bottom of the viewport.
  return {
    left: clamp(vw / 2 - CARD_WIDTH / 2, safe, vw - CARD_WIDTH - safe),
    top: vh - cardH - safe - margin,
    side: 'centred-bottom',
  };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function TourOverlay(): JSX.Element | null {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const def = getActiveDefinition();
  const stage: TourStage | null = def ? def.stages[snapshot.stageIndex] ?? null : null;
  const isLast = def !== null && snapshot.stageIndex === def.stages.length - 1;

  const [pos, setPos] = useState<CardPosition | null>(null);
  const [contentVisible, setContentVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useRef(false);

  // Autostart from menu navigation.
  useEffect(() => {
    reducedMotion.current = prefersReducedMotion();
    if (localStorage.getItem('tour.autostart') === '1') {
      localStorage.removeItem('tour.autostart');
      startTour(DEFAULT_TOUR);
    }
  }, []);

  // Hide markdown for one frame on stage change, restore once stage is no
  // longer in the entering phase.
  useEffect(() => {
    setContentVisible(false);
    if (snapshot.stageStatus !== 'entering') {
      const id = requestAnimationFrame(() => setContentVisible(true));
      return () => cancelAnimationFrame(id);
    }
    return undefined;
  }, [snapshot.stageIndex, snapshot.stageStatus]);

  const onLayout = useMemo(
    () => (rects: SpotlightRect[]) => {
      const u = unionOf(rects);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (!u) {
        setPos({
          left: clamp(vw / 2 - CARD_WIDTH / 2, 8, vw - CARD_WIDTH - 8),
          top: vh - 220,
          side: 'centred-bottom',
        });
        return;
      }
      const cardH = cardRef.current?.offsetHeight ?? 200;
      setPos(chooseSide(u, cardH, vw, vh));
    },
    [],
  );

  if (!snapshot.running || !stage) return null;

  const advanceDisabled =
    snapshot.stageStatus === 'entering' || snapshot.stageStatus === 'running-actions';

  const transition = reducedMotion.current
    ? 'opacity 180ms ease'
    : 'left 200ms ease, top 200ms ease, opacity 180ms ease';

  const cardStyle: React.CSSProperties = {
    position: 'fixed',
    left: pos?.left ?? -9999,
    top: pos?.top ?? -9999,
    width: CARD_WIDTH,
    padding: CARD_PADDING,
    background: 'var(--gel-white)',
    border: '1px solid var(--mist)',
    borderRadius: 'var(--r-12, 12px)',
    boxShadow: 'var(--el-2), var(--inner-gloss)',
    color: 'var(--ink)',
    fontFamily: 'var(--font-sans)',
    fontSize: '14px',
    lineHeight: 1.5,
    zIndex: 84,
    pointerEvents: 'auto',
    transition,
    opacity: pos ? 1 : 0,
  };

  const contentStyle: React.CSSProperties = {
    opacity: contentVisible ? 1 : 0,
    transition: 'opacity 180ms ease',
  };

  const buttonStyle: React.CSSProperties = {
    marginTop: 12,
    padding: '8px 14px',
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    fontWeight: 500,
    color: advanceDisabled ? 'var(--steel)' : 'var(--gel-white)',
    background: advanceDisabled ? 'var(--mist)' : 'var(--aqua-500)',
    border: '1px solid',
    borderColor: advanceDisabled ? 'var(--mist)' : 'var(--aqua-500)',
    borderRadius: 'var(--r-8, 8px)',
    cursor: advanceDisabled ? 'not-allowed' : 'pointer',
    transition: 'background 150ms ease, color 150ms ease, border-color 150ms ease',
  };

  return (
    <SpotlightOverlay
      cutouts={stage.cutouts}
      open={snapshot.running}
      onDismiss={end}
      showCloseButton={true}
      onLayout={onLayout}
    >
      <div ref={cardRef} role="dialog" aria-label="Tour step" style={cardStyle}>
        <div style={contentStyle}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{stage.markdown}</ReactMarkdown>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            disabled={advanceDisabled}
            onClick={() => {
              if (!advanceDisabled) next();
            }}
            style={buttonStyle}
          >
            {isLast ? 'End tour' : 'Next'}
          </button>
        </div>
      </div>
    </SpotlightOverlay>
  );
}
