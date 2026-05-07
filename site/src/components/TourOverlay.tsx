import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
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

const DEFAULT_CARD_WIDTH = 320;
const MIN_CARD_W = 280;
const MAX_CARD_W_CENTERED = 720;
const MAX_CARD_W_SPOTLIGHT = 480;
const PROBE_WIDTH = 400;
const PHI = 1.618;
const CARD_PADDING = 16;
const CARD_GAP = 16;
const MIN_FREE_H = 140;

type Side = 'right' | 'below' | 'left' | 'above' | 'centred-bottom';

interface CardPosition {
  left: number;
  top: number;
  side: Side;
}

interface CardSize {
  width: number;
  estHeight: number;
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
  cardW: number,
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

  const rightOk = rightFreeW >= cardW && vh - 2 * safe >= MIN_FREE_H;
  const belowOk = belowFreeH >= MIN_FREE_H && vw - 2 * safe >= cardW;
  const leftOk = leftFreeW >= cardW && vh - 2 * safe >= MIN_FREE_H;
  const aboveOk = aboveFreeH >= MIN_FREE_H && vw - 2 * safe >= cardW;

  if (rightOk) {
    const left = u.x + u.w + margin;
    const top = clamp(u.y + u.h / 2 - cardH / 2, safe, vh - cardH - safe);
    return { left, top, side: 'right' };
  }
  if (belowOk) {
    const top = u.y + u.h + margin;
    const left = clamp(u.x + u.w / 2 - cardW / 2, safe, vw - cardW - safe);
    return { left, top, side: 'below' };
  }
  if (leftOk) {
    const left = u.x - margin - cardW;
    const top = clamp(u.y + u.h / 2 - cardH / 2, safe, vh - cardH - safe);
    return { left, top, side: 'left' };
  }
  if (aboveOk) {
    const top = u.y - margin - cardH;
    const left = clamp(u.x + u.w / 2 - cardW / 2, safe, vw - cardW - safe);
    return { left, top, side: 'above' };
  }
  // Fallback — centred at the bottom of the viewport.
  return {
    left: clamp(vw / 2 - cardW / 2, safe, vw - cardW - safe),
    top: vh - cardH - safe - margin,
    side: 'centred-bottom',
  };
}

function measureAt(el: HTMLDivElement, w: number): number {
  el.style.width = `${w}px`;
  // Reading scrollHeight forces a synchronous layout.
  return el.scrollHeight;
}

function findGoldenSize(stage: TourStage, el: HTMLDivElement): CardSize {
  const hasCutouts = stage.cutouts.length > 0;
  const vw = window.innerWidth;
  const maxByViewport = Math.max(
    MIN_CARD_W,
    hasCutouts
      ? Math.min(vw * 0.4, MAX_CARD_W_SPOTLIGHT)
      : Math.min(vw * 0.6, MAX_CARD_W_CENTERED),
  );

  if (stage.cardWidth != null) {
    const w = clamp(stage.cardWidth, MIN_CARD_W, maxByViewport);
    return { width: w, estHeight: measureAt(el, w) };
  }

  // Initial guess: assume content area is roughly conserved across widths.
  const probeH = measureAt(el, PROBE_WIDTH);
  const area = PROBE_WIDTH * Math.max(probeH, 1);
  let w = clamp(Math.round(Math.sqrt(area * PHI)), MIN_CARD_W, maxByViewport);
  let h = measureAt(el, w);
  // Refine: width should equal φ × height. Re-measure at most twice — text
  // reflow makes the area-conservation guess off, but a couple of fixed-point
  // iterations converge quickly.
  for (let i = 0; i < 2; i++) {
    const ratio = w / Math.max(h, 1);
    if (Math.abs(ratio - PHI) / PHI < 0.05) break;
    const wNext = clamp(Math.round(h * PHI), MIN_CARD_W, maxByViewport);
    if (wNext === w) break;
    w = wNext;
    h = measureAt(el, w);
  }
  return { width: w, estHeight: h };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function TourOverlay(): JSX.Element | null {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const def = getActiveDefinition();
  const stage: TourStage | null = def ? def.stages[snapshot.stageIndex] ?? null : null;
  const isLast = def !== null && snapshot.stageIndex === def.stages.length - 1;

  const [cardSize, setCardSize] = useState<CardSize | null>(null);
  const [layoutRects, setLayoutRects] = useState<SpotlightRect[]>([]);
  const [cardActualHeight, setCardActualHeight] = useState<number | null>(null);
  const [contentVisible, setContentVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const measurerRef = useRef<HTMLDivElement | null>(null);
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

  // Iterative measurement: fixed-point search for a card width whose
  // w/h ratio ≈ golden, using the hidden measurer to read scrollHeight.
  useLayoutEffect(() => {
    if (!stage) return;
    setCardActualHeight(null);
    const measure = (): void => {
      const el = measurerRef.current;
      if (!el) return;
      setCardSize(findGoldenSize(stage, el));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [stage]);

  // Track the real card height so positioning uses an accurate value once
  // the browser has actually laid out the new width. Ignore zero readings —
  // they happen when the element is being detached during unmount and
  // would otherwise persist across tour close/reopen.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight;
      if (h > 0) setCardActualHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [cardSize]);

  const onLayout = useCallback((rects: SpotlightRect[]) => {
    setLayoutRects(rects);
  }, []);

  const pos: CardPosition | null = useMemo(() => {
    if (!cardSize) return null;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardH = cardActualHeight && cardActualHeight > 0 ? cardActualHeight : cardSize.estHeight;
    const u = unionOf(layoutRects);
    if (!u) {
      return {
        left: clamp(vw / 2 - cardSize.width / 2, 8, vw - cardSize.width - 8),
        top: clamp((vh - cardH) / 2, 8, vh - cardH - 8),
        side: 'centred-bottom',
      };
    }
    return chooseSide(u, cardSize.width, cardH, vw, vh);
  }, [cardSize, layoutRects, cardActualHeight]);

  if (!snapshot.running || !stage) return null;

  const advanceDisabled =
    snapshot.stageStatus === 'entering' || snapshot.stageStatus === 'running-actions';

  const transition = reducedMotion.current
    ? 'opacity 180ms ease'
    : 'left 200ms ease, top 200ms ease, opacity 180ms ease';

  const width = cardSize?.width ?? DEFAULT_CARD_WIDTH;

  const cardStyle: React.CSSProperties = {
    position: 'fixed',
    left: pos?.left ?? -9999,
    top: pos?.top ?? -9999,
    width,
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
    boxSizing: 'border-box',
  };

  const measurerStyle: React.CSSProperties = {
    position: 'fixed',
    left: -99999,
    top: 0,
    // width is assigned imperatively by findGoldenSize during layout effect.
    padding: CARD_PADDING,
    fontFamily: 'var(--font-sans)',
    fontSize: '14px',
    lineHeight: 1.5,
    visibility: 'hidden',
    pointerEvents: 'none',
    boxSizing: 'border-box',
  };

  const contentStyle: React.CSSProperties = {
    opacity: contentVisible ? 1 : 0,
    transition: 'opacity 180ms ease',
  };

  const buttonStyle: React.CSSProperties = advanceDisabled
    ? { visibility: 'hidden' }
    : {};

  return (
    <>
      <div ref={measurerRef} aria-hidden="true" style={measurerStyle}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{stage.markdown}</ReactMarkdown>
        {/* Reserve room for the button row so the area estimate isn't short. */}
        <div style={{ marginTop: 12, height: 32 }} />
      </div>
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
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button
            type="button"
            className="btn btn-primary"
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
    </>
  );
}
