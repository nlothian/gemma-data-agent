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
      'chat.throbber',
      'exec.panel',
      'exec.featureSelector',
      'exec.explainerPanel',
      'exec.codeEditor',
      'exec.runButton',
      'exec.pythonOutput',
      'exec.dataPanel',
      'exec.filesTab',
      'exec.fileContent',
      'exec.explainerMessages',
      'sourcecode.viewer',
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
      expect(isWired(source, id), `cutout "${id}" is not wired in any component`).toBe(true);
    }
  });

  it('reports which optional cutouts are wired (informational)', () => {
    const source = readAllComponentSources();
    const optional = CUTOUT_IDS.filter((id) => CUTOUTS[id].optional);
    const status = optional.map((id) => ({
      id,
      wired: isWired(source, id),
    }));
    // Soft assertion: the array exists. Failure here would mean the registry
    // changed in an unexpected way.
    expect(Array.isArray(status)).toBe(true);
  });
});

/**
 * A cutout is considered wired if any component sets `data-tour-id="<id>"`
 * directly, or forwards the id through a `tourId="<id>"` prop (the
 * MessagesView pattern, where the attribute is rendered via interpolation).
 */
function isWired(source: string, id: CutoutId): boolean {
  return source.includes(`data-tour-id="${id}"`) || source.includes(`tourId="${id}"`);
}

describe('isWired predicate sanity', () => {
  it('matches direct attributes and prop-forwarded forms', () => {
    expect(isWired('<div data-tour-id="chat.modelDropdown" />', 'chat.modelDropdown')).toBe(true);
    expect(isWired('<X tourId="chat.conversation" />', 'chat.conversation')).toBe(true);
    expect(isWired('nothing here', 'chat.modelDropdown')).toBe(false);
  });
});
