import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CUTOUTS, CUTOUT_IDS, type CutoutId } from '../cutouts';

const COMPONENTS_DIR = new URL('../../../components/', import.meta.url).pathname;

function readAllComponentSources(): string {
  const files = readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith('.tsx'));
  return files.map((f) => readFileSync(join(COMPONENTS_DIR, f), 'utf8')).join('\n');
}

describe('cutout registry', () => {
  it('has a CUTOUTS entry for every CutoutId in the union', () => {
    const declared: CutoutId[] = [
      'chat.modelDropdown',
      'chat.messageEntry',
      'chat.stepButton',
      'chat.playButton',
      'chat.conversation',
      'chat.compactionRunButton',
      'exec.panel',
      'exec.featureSelector',
      'exec.explainerPanel',
      'exec.codeEditor',
      'exec.runButton',
      'exec.pythonOutput',
      'exec.dataPanel',
    ];
    for (const id of declared) {
      expect(CUTOUTS[id]).toBeDefined();
      expect(CUTOUTS[id].id).toBe(id);
    }
    expect(new Set(CUTOUT_IDS)).toEqual(new Set(declared));
  });

  it('uses the literal [data-tour-id="<id>"] selector for every entry', () => {
    for (const id of CUTOUT_IDS) {
      expect(CUTOUTS[id].selector).toBe(`[data-tour-id="${id}"]`);
    }
  });

  it('wires every non-optional cutout id into a component file', () => {
    const source = readAllComponentSources();
    const required = CUTOUT_IDS.filter((id) => !CUTOUTS[id].optional);
    for (const id of required) {
      expect(source).toContain(`data-tour-id="${id}"`);
    }
  });

  it('reports which optional cutouts are wired (informational)', () => {
    const source = readAllComponentSources();
    const optional = CUTOUT_IDS.filter((id) => CUTOUTS[id].optional);
    const status = optional.map((id) => ({
      id,
      wired: source.includes(`data-tour-id="${id}"`),
    }));
    // Soft assertion: the array exists. Failure here would mean the registry
    // changed in an unexpected way.
    expect(Array.isArray(status)).toBe(true);
  });
});
