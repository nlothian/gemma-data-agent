import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { CloseIcon } from './Icons';
import { CUTOUTS, type CutoutId } from '../lib/tour/cutouts';

// Keep the transparent mask aligned to the target element itself.
// Expanding it outward makes neighboring button cutouts overlap in pause mode.
const CUTOUT_INSET = 0;
const CORNER_RADIUS = 12;
const FADE_IN_MS = 180;
const FADE_OUT_MS = 140;
const TWEEN_MS = 250;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

export function insetRect(r: Rect, by: number): Rect {
  const inset = Math.min(by, r.w / 2, r.h / 2);
  return {
    x: r.x + inset,
    y: r.y + inset,
    w: r.w - inset * 2,
    h: r.h - inset * 2,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    w: lerp(a.w, b.w, t),
    h: lerp(a.h, b.h, t),
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function unionRects(rects: ReadonlyArray<Rect>): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function spotlightRectForRects(rects: ReadonlyArray<Rect>): Rect {
  return insetRect(unionRects(rects), CUTOUT_INSET);
}

function selectorsFor(id: CutoutId): string[] {
  const def = CUTOUTS[id];
  if (!def) return [];
  return def.extraSelectors ? [def.selector, ...def.extraSelectors] : [def.selector];
}

function resolveCutoutRects(ids: ReadonlyArray<CutoutId>): Rect[] {
  const out: Rect[] = [];
  for (const id of ids) {
    const def = CUTOUTS[id];
    if (!def) continue;
    const rects: Rect[] = [];
    for (const sel of selectorsFor(id)) {
      document.querySelectorAll(sel).forEach((el) => rects.push(rectOf(el)));
    }
    if (rects.length === 0) continue;
    out.push(spotlightRectForRects(rects));
  }
  return out;
}

function alignByLength(prev: Rect[], next: Rect[]): Rect[] {
  // Pad the shorter side with copies of the last rect so cutouts can
  // appear/disappear via tween rather than popping in/out.
  if (prev.length === next.length) return prev;
  if (prev.length === 0) return next.map((r) => r);
  if (prev.length < next.length) {
    const tail = prev[prev.length - 1];
    return [...prev, ...next.slice(prev.length).map(() => tail)];
  }
  // prev.length > next.length — pad next; caller flips when needed.
  return prev;
}

export interface SpotlightOverlayProps {
  cutouts: ReadonlyArray<CutoutId>;
  open: boolean;
  onDismiss?: () => void;
  showCloseButton?: boolean;
  /** Children render above the mask; e.g. a tour panel anchored to a cutout. */
  children?: React.ReactNode;
  /** Callback when the cutout layout (rects) updates — used by anchored panels. */
  onLayout?: (rects: Rect[]) => void;
  zIndex?: number;
}

export type { Rect as SpotlightRect };

export default function SpotlightOverlay(props: SpotlightOverlayProps): JSX.Element | null {
  const { cutouts, open, onDismiss, showCloseButton = true, children, onLayout, zIndex = 80 } = props;
  const maskId = useId();
  const [phase, setPhase] = useState<'entering' | 'visible' | 'leaving' | null>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const [vp, setVp] = useState<{ vw: number; vh: number }>({
    vw: typeof window === 'undefined' ? 0 : window.innerWidth,
    vh: typeof window === 'undefined' ? 0 : window.innerHeight,
  });
  const reducedMotion = useRef(false);
  const tweenRaf = useRef<number | null>(null);
  const prevRectsRef = useRef<Rect[]>([]);

  // Phase machine.
  useEffect(() => {
    if (open) {
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
  }, [open]);

  // Resolve and observe cutouts whenever the visible set changes.
  useEffect(() => {
    if (phase === null) return;

    let cancelled = false;
    let ro: ResizeObserver | null = null;
    const observedEls = new Set<Element>();

    const collectCutoutElements = (): Element[] => {
      const els: Element[] = [];
      for (const id of cutouts) {
        for (const sel of selectorsFor(id)) {
          document.querySelectorAll(sel).forEach((el) => els.push(el));
        }
      }
      return els;
    };

    // Re-sync the ResizeObserver to whatever elements currently match the
    // active cutout selectors. Cutout targets can mount/unmount across a
    // stage's lifetime (e.g. the activity throbber, which only renders while
    // the LLM is busy), so the RO membership has to follow the DOM rather
    // than be fixed at effect-setup time. Without this, a cutout that grew
    // when its element first appeared would not shrink back when the
    // element's *contents* later resized (size changes don't fire the
    // MutationObserver).
    const syncResizeObserver = (): void => {
      if (!ro) return;
      const current = new Set(collectCutoutElements());
      for (const el of observedEls) {
        if (!current.has(el)) {
          ro.unobserve(el);
          observedEls.delete(el);
        }
      }
      for (const el of current) {
        if (!observedEls.has(el)) {
          ro.observe(el);
          observedEls.add(el);
        }
      }
    };

    const recompute = (): void => {
      if (cancelled) return;
      setVp({ vw: window.innerWidth, vh: window.innerHeight });
      const target = resolveCutoutRects(cutouts);
      animateTo(target);
      syncResizeObserver();
    };

    const animateTo = (target: Rect[]): void => {
      const prev = prevRectsRef.current;
      if (reducedMotion.current || prev.length === 0) {
        prevRectsRef.current = target;
        setRects(target);
        if (onLayout) onLayout(target);
        return;
      }
      const from = alignByLength(prev, target);
      const to = target.length >= from.length
        ? target
        : alignByLength(target, from);
      const len = Math.max(from.length, to.length);
      const fromPad: Rect[] = Array.from({ length: len }, (_, i) => from[i] ?? from[from.length - 1]);
      const toPad: Rect[] = Array.from({ length: len }, (_, i) => to[i] ?? to[to.length - 1]);
      const start = performance.now();
      if (tweenRaf.current !== null) cancelAnimationFrame(tweenRaf.current);
      const tick = (now: number): void => {
        if (cancelled) return;
        const t = Math.min(1, (now - start) / TWEEN_MS);
        const eased = easeInOut(t);
        const interp = fromPad.map((f, i) => lerpRect(f, toPad[i], eased));
        const visible = t === 1 ? target : interp;
        prevRectsRef.current = visible;
        setRects(visible);
        if (onLayout) onLayout(visible);
        if (t < 1) tweenRaf.current = requestAnimationFrame(tick);
        else tweenRaf.current = null;
      };
      tweenRaf.current = requestAnimationFrame(tick);
    };

    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(recompute);
    }

    recompute();

    // Watch for cutout targets that mount/unmount after the initial scan
    // (e.g. a popover opened by an onEnter action). The MutationObserver
    // triggers a recompute when an element matching any active cutout
    // selector enters or leaves the DOM.
    let mo: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined') {
      const allSelectors = cutouts.flatMap((id) => selectorsFor(id));
      mo = new MutationObserver((records) => {
        for (const rec of records) {
          if (rec.type === 'attributes') {
            recompute();
            return;
          }
          for (const node of rec.addedNodes) {
            if (node.nodeType !== 1) continue;
            const el = node as Element;
            if (allSelectors.some((sel) => el.matches?.(sel) || el.querySelector?.(sel))) {
              recompute();
              return;
            }
          }
          for (const node of rec.removedNodes) {
            if (node.nodeType !== 1) continue;
            const el = node as Element;
            if (allSelectors.some((sel) => el.matches?.(sel) || el.querySelector?.(sel))) {
              recompute();
              return;
            }
          }
        }
      });
      mo.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-tour-id'],
      });
    }

    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);

    // CSS transitions on transform/inset properties move a cutout's
    // bounding rect without firing ResizeObserver (size-invariant) or the
    // MutationObserver (no DOM change). Without this, an overlay that
    // slides in (e.g. the Sourcecode drawer's translateX transition) has
    // its rect stuck at the pre-transition position. Recomputing on
    // transitionend re-reads getBoundingClientRect once the panel settles.
    const onTransitionEnd = (e: TransitionEvent): void => {
      const p = e.propertyName;
      if (
        p === 'transform' ||
        p === 'left' ||
        p === 'top' ||
        p === 'right' ||
        p === 'bottom' ||
        p === 'inset'
      ) {
        recompute();
      }
    };
    document.addEventListener('transitionend', onTransitionEnd, true);

    return () => {
      cancelled = true;
      if (tweenRaf.current !== null) {
        cancelAnimationFrame(tweenRaf.current);
        tweenRaf.current = null;
      }
      window.removeEventListener('resize', recompute);
      window.removeEventListener('scroll', recompute, true);
      document.removeEventListener('transitionend', onTransitionEnd, true);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [phase, cutouts, onLayout]);

  // Reset prevRects when overlay fully closes so the next open animates fresh.
  useEffect(() => {
    if (phase === null) {
      prevRectsRef.current = [];
      setRects([]);
    }
  }, [phase]);

  // Escape to dismiss.
  const handleClose = useCallback((): void => {
    if (onDismiss) onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    if (phase === null) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && onDismiss) onDismiss();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [phase, onDismiss]);

  if (phase === null) return null;
  if (typeof document === 'undefined') return null;

  const opacity = phase === 'visible' ? 1 : 0;
  const fadeMs = reducedMotion.current
    ? 60
    : phase === 'leaving'
      ? FADE_OUT_MS
      : FADE_IN_MS;
  const transition = `opacity ${fadeMs}ms ${phase === 'leaving' ? 'ease-in' : 'ease-out'}`;
  const { vw, vh } = vp;

  const svgStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    width: '100vw',
    height: '100vh',
    pointerEvents: 'none',
    opacity,
    transition,
    zIndex,
  };

  const closeBtnStyle: React.CSSProperties = {
    position: 'fixed',
    top: 16,
    right: 16,
    pointerEvents: 'auto',
    opacity,
    transition: `opacity ${fadeMs}ms ${phase === 'leaving' ? 'ease-in' : 'ease-out'}, transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease`,
    zIndex: zIndex + 2,
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
            {rects.map((c, i) => (
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
      {rects.map((c, i) => (
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
            transition,
            boxShadow:
              'inset 0 2px 6px rgba(0, 0, 0, 0.45), inset 0 0 16px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.35)',
            zIndex: zIndex + 1,
          }}
          aria-hidden="true"
        />
      ))}
      {children}
      {showCloseButton && onDismiss ? (
        <button
          type="button"
          className="btn btn-secondary"
          style={closeBtnStyle}
          onClick={handleClose}
          aria-label="Dismiss"
        >
          <CloseIcon size={14} />
          Close
        </button>
      ) : null}
    </>,
    document.body,
  );
}
