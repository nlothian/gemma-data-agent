import { describe, it, expect } from 'vitest';
import { DEFAULT_TOUR } from '../stages';
import { CUTOUT_IDS } from '../cutouts';
import { ACTION_NAMES } from '../actions';

describe('DEFAULT_TOUR', () => {
  it('has a non-empty stages array', () => {
    expect(DEFAULT_TOUR.stages.length).toBeGreaterThan(0);
  });

  it('every stage has a non-empty markdown string', () => {
    for (const stage of DEFAULT_TOUR.stages) {
      expect(typeof stage.markdown).toBe('string');
      expect(stage.markdown.trim().length).toBeGreaterThan(0);
    }
  });

  it('every stage has a unique id', () => {
    const ids = DEFAULT_TOUR.stages.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });

  it('every stage cutout id is in CUTOUT_IDS', () => {
    const valid = new Set<string>(CUTOUT_IDS);
    for (const stage of DEFAULT_TOUR.stages) {
      expect(stage.cutouts.length).toBeGreaterThan(0);
      for (const id of stage.cutouts) {
        expect(valid.has(id)).toBe(true);
      }
    }
  });

  it('every onEnter step references a known action name', () => {
    const valid = new Set<string>(ACTION_NAMES);
    for (const stage of DEFAULT_TOUR.stages) {
      for (const step of stage.onEnter ?? []) {
        expect(valid.has(step.action)).toBe(true);
      }
    }
  });

  it('every stage has a recognised next mode', () => {
    const allowed = new Set([undefined, 'manual', 'auto-after-actions']);
    for (const stage of DEFAULT_TOUR.stages) {
      expect(allowed.has(stage.next)).toBe(true);
    }
  });
});
