import {
  getServerSnapshot,
  getSnapshot,
  subscribe,
} from '../lib/toolDebugger';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

import { CloseIcon } from './Icons';
import { createPortal } from 'react-dom';
import { COMPACTION_TOOL_NAME } from '../lib/autoCompaction';

const EXPLAINABLE_TOOLS = new Set([
  'RunPython',
  'RunSQL',
  'LoadData',
  COMPACTION_TOOL_NAME,
]);
const PADDING = 8;
const CORNER_RADIUS = 12;
const FADE_IN_MS = 180;
const FADE_OUT_MS = 140;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: right - x, h: bottom - y };
}

function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

interface Layout {
  vw: number;
  vh: number;
  cutouts: Rect[];
}

function codeAreaSelector(toolName: string): string | null {
  if (toolName === 'RunPython' || toolName === 'RunSQL') {
    return '.exec-editor-section';
  }
  if (toolName === 'LoadData') return '.data-panel';
  return null;
}

function computeLayout(toolName: string): Layout | null {
  const explainerEl = document.querySelector('.explainer-panel');
  const stepEl = document.querySelector('button[aria-label="Step"]');
  if (!explainerEl || !stepEl) return null;

  const playEl = document.querySelector('button[aria-label="Play"]');
  const stepRect = rectOf(stepEl);
  const buttonsRaw = playEl ? unionRect(stepRect, rectOf(playEl)) : stepRect;

  const cutouts: Rect[] = [
    inflate(rectOf(explainerEl), PADDING),
    inflate(buttonsRaw, PADDING),
  ];

  const codeSel = codeAreaSelector(toolName);
  if (codeSel) {
    const codeEl = document.querySelector(codeSel);
    if (codeEl) cutouts.push(inflate(rectOf(codeEl), PADDING));
  }

  return { vw: window.innerWidth, vh: window.innerHeight, cutouts };
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export default function PauseCoachmark() {
  const debug = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const maskId = useId();

  const toolName = debug.pending?.toolName ?? null;
  const shouldShow =
    debug.mode === 'paused' &&
    toolName !== null &&
    EXPLAINABLE_TOOLS.has(toolName);

  const [phase, setPhase] = useState<'entering' | 'visible' | 'leaving' | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [layout, setLayout] = useState<Layout | null>(null);
  const reducedMotion = useRef(false);

  useEffect(() => {
    if (!shouldShow) setDismissed(false);
  }, [shouldShow]);

  const wantOpen = shouldShow && !dismissed;

  useEffect(() => {
    if (wantOpen) {
      reducedMotion.current = prefersReducedMotion();
      setPhase('entering');
      const t = window.setTimeout(() => setPhase('visible'), 16);
      return () => window.clearTimeout(t);
    }
    if (phase === null) return;
    setPhase('leaving');
    const t = window.setTimeout(
      () => setPhase(null),
      reducedMotion.current ? 60 : FADE_OUT_MS,
    );
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantOpen]);

  useEffect(() => {
    if (phase === null || toolName === null) return;

    const recompute = (): void => {
      setLayout(computeLayout(toolName));
    };

    recompute();

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(recompute);
      const codeSel = codeAreaSelector(toolName);
      const targets = [
        document.querySelector('.explainer-panel'),
        document.querySelector('button[aria-label="Step"]'),
        document.querySelector('button[aria-label="Play"]'),
        codeSel ? document.querySelector(codeSel) : null,
      ].filter((el): el is Element => el !== null);
      for (const t of targets) ro.observe(t);
    }

    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);

    return () => {
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
      ro?.disconnect();
    };
  }, [phase, toolName]);

  const handleClose = useCallback((): void => {
    setDismissed(true);
  }, []);

  useEffect(() => {
    if (phase === null) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setDismissed(true);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [phase]);

  if (phase === null || layout === null) return null;

  const opacity = phase === 'visible' ? 1 : 0;
  const fadeMs = reducedMotion.current
    ? 60
    : phase === 'leaving'
      ? FADE_OUT_MS
      : FADE_IN_MS;

  const { vw, vh, cutouts } = layout;

  const svgStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',
    opacity,
    transition: `opacity ${fadeMs}ms ${phase === 'leaving' ? 'ease-in' : 'ease-out'}`,
    zIndex: 80,
  };

  const closeBtnStyle: React.CSSProperties = {
    position: 'fixed',
    top: 16,
    right: 16,
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
    transition: `border-color 150ms ease, color 150ms ease, opacity ${fadeMs}ms ${phase === 'leaving' ? 'ease-in' : 'ease-out'}`,
    boxShadow: 'var(--el-1), var(--inner-gloss)',
    pointerEvents: 'auto',
    opacity,
    zIndex: 82,
  };

  return createPortal(
    <>
      <svg
        style={svgStyle}
        viewBox={`0 0 ${vw} ${vh}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <mask id={maskId}>
            <rect x={0} y={0} width={vw} height={vh} fill="white" />
            {cutouts.map((c, i) => (
              <rect
                key={i}
                x={c.x}
                y={c.y}
                width={c.w}
                height={c.h}
                rx={CORNER_RADIUS}
                ry={CORNER_RADIUS}
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect
          x={0}
          y={0}
          width={vw}
          height={vh}
          fill="rgba(15, 20, 25, 0.65)"
          mask={`url(#${maskId})`}
        />
      </svg>
      {/* Inset shadow on each cutout — uses CSS box-shadow inset to make
          the highlighted area look recessed into the dim surface. */}
      {cutouts.map((c, i) => (
        <div
          key={`inset-${i}`}
          style={{
            position: 'fixed',
            left: c.x,
            top: c.y,
            width: c.w,
            height: c.h,
            borderRadius: CORNER_RADIUS,
            pointerEvents: 'none',
            opacity,
            transition: `opacity ${fadeMs}ms ${phase === 'leaving' ? 'ease-in' : 'ease-out'}`,
            boxShadow:
              'inset 0 2px 6px rgba(0, 0, 0, 0.45), inset 0 0 16px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.35)',
            zIndex: 81,
          }}
          aria-hidden="true"
        />
      ))}
      <button
        type="button"
        style={closeBtnStyle}
        onClick={handleClose}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--silver)';
          e.currentTarget.style.color = 'var(--ink)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--mist)';
          e.currentTarget.style.color = 'var(--graphite)';
        }}
        aria-label="Dismiss explainer hint"
      >
        <CloseIcon size={14} />
        Close
      </button>
    </>,
    document.body,
  );
}
