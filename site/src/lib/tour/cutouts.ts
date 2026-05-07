/**
 * Named cutout registry for the tour and pause coachmark.
 *
 * Each entry maps a stable `CutoutId` to a CSS selector that resolves to a
 * single DOM element to spotlight. Targets carry a matching
 * `data-tour-id="<CutoutId>"` attribute in their component source.
 */

export type CutoutId =
  | 'chat.modelDropdown'
  | 'chat.messageEntry'
  | 'chat.stepButton'
  | 'chat.playButton'
  | 'chat.conversation'
  | 'chat.compactionRunButton'
  | 'chat.throbber'
  | 'exec.panel'
  | 'exec.featureSelector'
  | 'exec.explainerPanel'
  | 'exec.codeEditor'
  | 'exec.runButton'
  | 'exec.pythonOutput'
  | 'exec.dataPanel'
  | 'exec.explainerMessages'
  | 'sourcecode.viewer';

export interface CutoutDef {
  id: CutoutId;
  selector: string;
  /**
   * Extra selectors whose elements get unioned with the primary selector when
   * computing the spotlight rect. Used when an element visually part of the
   * cutout is positioned absolutely (e.g. a popover anchored to a trigger).
   */
  extraSelectors?: string[];
  label: string;
  optional?: boolean;
}

function dt(id: CutoutId): string {
  return `[data-tour-id="${id}"]`;
}

export const CUTOUTS: Record<CutoutId, CutoutDef> = {
  'chat.modelDropdown': {
    id: 'chat.modelDropdown',
    selector: dt('chat.modelDropdown'),
    extraSelectors: ['[data-tour-id="chat.modelPopover"]'],
    label: 'Model selection dropdown trigger',
  },
  'chat.messageEntry': {
    id: 'chat.messageEntry',
    selector: dt('chat.messageEntry'),
    label: 'Chat message textarea',
  },
  'chat.stepButton': {
    id: 'chat.stepButton',
    selector: dt('chat.stepButton'),
    label: 'Step button',
  },
  'chat.playButton': {
    id: 'chat.playButton',
    selector: dt('chat.playButton'),
    label: 'Play button',
    optional: true,
  },
  'chat.conversation': {
    id: 'chat.conversation',
    selector: dt('chat.conversation'),
    label: 'Conversation message list',
  },
  'chat.compactionRunButton': {
    id: 'chat.compactionRunButton',
    selector: dt('chat.compactionRunButton'),
    label: 'Compact / Run compaction button',
    optional: true,
  },
  'chat.throbber': {
    id: 'chat.throbber',
    selector: dt('chat.throbber'),
    label: 'Activity throbber ("Thinking", "Running Python", …)',
    optional: true,
  },
  'exec.panel': {
    id: 'exec.panel',
    selector: dt('exec.panel'),
    label: 'Execution panel (tabs + body)',
  },
  'exec.featureSelector': {
    id: 'exec.featureSelector',
    selector: dt('exec.featureSelector'),
    extraSelectors: ['[data-tour-id="exec.featurePopover"]'],
    label: 'Feature selector trigger',
  },
  'exec.explainerPanel': {
    id: 'exec.explainerPanel',
    selector: dt('exec.explainerPanel'),
    label: 'Explainer panel',
    optional: true,
  },
  'exec.codeEditor': {
    id: 'exec.codeEditor',
    selector: dt('exec.codeEditor'),
    label: 'Code editor section',
    optional: true,
  },
  'exec.runButton': {
    id: 'exec.runButton',
    selector: dt('exec.runButton'),
    label: 'Run edited code button',
    optional: true,
  },
  'exec.pythonOutput': {
    id: 'exec.pythonOutput',
    selector: dt('exec.pythonOutput'),
    label: 'Python output / plot view',
    optional: true,
  },
  'exec.dataPanel': {
    id: 'exec.dataPanel',
    selector: dt('exec.dataPanel'),
    label: 'Data panel',
    optional: true,
  },
  'exec.explainerMessages': {
    id: 'exec.explainerMessages',
    selector: dt('exec.explainerMessages'),
    label: 'Explainer conversation message list',
    optional: true,
  },
  'sourcecode.viewer': {
    id: 'sourcecode.viewer',
    selector: dt('sourcecode.viewer'),
    label: 'Sourcecode overlay panel',
    optional: true,
  },
};

export const CUTOUT_IDS = Object.keys(CUTOUTS) as CutoutId[];

export function isCutoutId(value: string): value is CutoutId {
  return Object.prototype.hasOwnProperty.call(CUTOUTS, value);
}

export function resolveCutout(id: CutoutId): Element | null {
  const def = CUTOUTS[id];
  if (!def) return null;
  return document.querySelector(def.selector);
}
