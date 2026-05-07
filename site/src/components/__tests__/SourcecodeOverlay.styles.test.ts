import { describe, it, expect } from 'vitest';
import {
  buildBackdropStyle,
  buildPanelStyle,
} from '../SourcecodeOverlay';

/**
 * Regression: when the Sourcecode overlay is closed it must not visually
 * cover, nor steal pointer events from, the rest of the page (in particular
 * the execution-panel tabs row, which lives in the main column underneath).
 *
 * The overlay is mounted at the layout level and its <aside> is a
 * `position: fixed` panel with `top:0; right:0; bottom:0; width:min(960px, 95vw)`.
 * The closed-state contract that keeps it harmless is:
 *   1. `pointer-events: none` so clicks fall through to underlying UI.
 *   2. A transform that translates the panel its own full width to the
 *      right, so it sits entirely off-screen.
 *   3. The same `pointer-events: none` on the backdrop, which covers the
 *      whole viewport (`inset: 0`) regardless of `open`.
 *   4. Backdrop `opacity: 0` so it isn't visible either.
 */
describe('SourcecodeOverlay closed-state contract', () => {
  describe('panel', () => {
    it('is non-interactive when closed', () => {
      expect(buildPanelStyle(false).pointerEvents).toBe('none');
    });

    it('is translated fully off-screen to the right when closed', () => {
      // Must be exactly `translateX(100%)` so the panel slides out by its
      // own width regardless of viewport size.
      expect(buildPanelStyle(false).transform).toBe('translateX(100%)');
    });

    it('uses fixed positioning anchored to the right edge', () => {
      const s = buildPanelStyle(false);
      expect(s.position).toBe('fixed');
      expect(s.right).toBe(0);
      expect(s.top).toBe(0);
      expect(s.bottom).toBe(0);
    });

    it('becomes interactive and on-screen when open', () => {
      const s = buildPanelStyle(true);
      expect(s.pointerEvents).toBe('auto');
      expect(s.transform).toBe('translateX(0)');
    });
  });

  describe('backdrop', () => {
    it('is invisible and non-interactive when closed', () => {
      const s = buildBackdropStyle(false);
      expect(s.opacity).toBe(0);
      expect(s.pointerEvents).toBe('none');
    });

    it('covers the viewport via fixed positioning', () => {
      const s = buildBackdropStyle(false);
      expect(s.position).toBe('fixed');
      expect(s.inset).toBe(0);
    });

    it('becomes visible and clickable when open', () => {
      const s = buildBackdropStyle(true);
      expect(s.opacity).toBe(1);
      expect(s.pointerEvents).toBe('auto');
    });
  });
});
