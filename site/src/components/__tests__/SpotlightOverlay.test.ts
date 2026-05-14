import { describe, expect, it } from 'vitest';

import { insetRect, spotlightRectForRects } from '../SpotlightOverlay';

describe('SpotlightOverlay geometry', () => {
  it('keeps a single cutout aligned to the element bounds', () => {
    const target = { x: 20, y: 30, w: 48, h: 48 };

    expect(spotlightRectForRects([target])).toEqual(target);
  });

  it('does not expand adjacent button cutouts into each other', () => {
    const stepButton = { x: 0, y: 0, w: 48, h: 48 };
    const playButton = { x: 56, y: 0, w: 48, h: 48 };

    const stepCutout = spotlightRectForRects([stepButton]);
    const playCutout = spotlightRectForRects([playButton]);

    expect(stepCutout.x + stepCutout.w).toBeLessThanOrEqual(playCutout.x);
  });

  it('clamps inset values so tiny rects never become negative sized', () => {
    expect(insetRect({ x: 10, y: 20, w: 4, h: 2 }, 8)).toEqual({
      x: 11,
      y: 21,
      w: 2,
      h: 0,
    });
  });
});
