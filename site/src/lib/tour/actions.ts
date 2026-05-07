/**
 * Tour action API. Single typed entry point: `performAction(name, params)`.
 *
 * Each action drives one UI operation, either via the tour bridge (for
 * component-local state) or via an existing global store / DOM click. Adding
 * a new action requires:
 *   1. extending `ActionName` and `ActionParams`
 *   2. adding a case in the switch in `performAction`
 *   3. updating the JSDoc above that case so the README stays accurate
 */

import * as agentFeatures from '../agentFeaturesStore';
import * as executionPanelStore from '../executionPanelStore';
import type { AgentPromptFeatures } from '../agentTools';
import {
  popForceExpand,
  pushForceExpand,
  setExecCollapsed,
  setExplainerCollapsed,
} from '../paneCollapseStore';
import { closeSourcecode as closeSourcecodeOverlay } from '../sourcecode/uiStore';
import { getChatBridge, getExecBridge, getExplainerBridge } from './bridge';
import { CUTOUTS, type CutoutId } from './cutouts';

const DEFAULT_WAIT_TIMEOUT_MS = 60000;

export type FeatureKey = keyof AgentPromptFeatures;

export type ActionName =
  | 'toggleModelDropdown'
  | 'selectModel'
  | 'typeMessage'
  | 'pressStepButton'
  | 'pressPlayButton'
  | 'pressRunButton'
  | 'toggleFeatureSelector'
  | 'setEnabledFeatures'
  | 'setPythonCode'
  | 'waitForLlmIdle'
  | 'waitForPythonIdle'
  | 'newChat'
  | 'pressExplainerExpand'
  | 'pressAgentsExpand'
  | 'typeExplainerMessage'
  | 'sendExplainerMessage'
  | 'waitForExplainerIdle'
  | 'clickFirstSourcecodeLink'
  | 'closeSourcecode';

export interface ActionParams {
  toggleModelDropdown: { open: boolean };
  selectModel: { modelId: string };
  typeMessage: { text: string; clearFirst?: boolean };
  pressStepButton: Record<string, never>;
  pressPlayButton: Record<string, never>;
  pressRunButton: Record<string, never>;
  toggleFeatureSelector: { open: boolean };
  setEnabledFeatures: { features: Partial<Record<FeatureKey, boolean>> };
  setPythonCode: { code: string };
  waitForLlmIdle: { timeoutMs?: number };
  waitForPythonIdle: { timeoutMs?: number };
  newChat: Record<string, never>;
  pressExplainerExpand: Record<string, never>;
  pressAgentsExpand: Record<string, never>;
  typeExplainerMessage: { text: string };
  sendExplainerMessage: Record<string, never>;
  waitForExplainerIdle: { timeoutMs?: number };
  clickFirstSourcecodeLink: Record<string, never>;
  closeSourcecode: Record<string, never>;
}

export const ACTION_NAMES: ReadonlyArray<ActionName> = [
  'toggleModelDropdown',
  'selectModel',
  'typeMessage',
  'pressStepButton',
  'pressPlayButton',
  'pressRunButton',
  'toggleFeatureSelector',
  'setEnabledFeatures',
  'setPythonCode',
  'waitForLlmIdle',
  'waitForPythonIdle',
  'newChat',
  'pressExplainerExpand',
  'pressAgentsExpand',
  'typeExplainerMessage',
  'sendExplainerMessage',
  'waitForExplainerIdle',
  'clickFirstSourcecodeLink',
  'closeSourcecode',
];

export function isActionName(value: string): value is ActionName {
  return (ACTION_NAMES as ReadonlyArray<string>).includes(value);
}

function clickCutout(id: CutoutId): void {
  const el = document.querySelector(CUTOUTS[id].selector);
  if (!el) {
    throw new Error(`tour: cannot click missing cutout "${id}"`);
  }
  (el as HTMLElement).click();
}

function assertNever(x: never): never {
  throw new Error(`tour: unhandled action ${String(x)}`);
}

function waitForLlmIdle(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let sawActive = executionPanelStore.getSnapshot().llm.active;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };

    const unsubscribe = executionPanelStore.subscribe(() => {
      const active = executionPanelStore.getSnapshot().llm.active;
      if (active) {
        sawActive = true;
        return;
      }
      if (sawActive) finish();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        console.warn('tour: waitForLlmIdle timed out');
      }
      finish();
    }, timeoutMs);
  });
}

function waitForExplainerIdle(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const bridge = getExplainerBridge();
    let sawActive = bridge.isStreamingActive();
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };

    const unsubscribe = bridge.subscribeStreaming(() => {
      const active = bridge.isStreamingActive();
      if (active) {
        sawActive = true;
        return;
      }
      if (sawActive) finish();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        console.warn('tour: waitForExplainerIdle timed out');
      }
      finish();
    }, timeoutMs);
  });
}

function clickFirstSourcecodeLink(): void {
  const el = document.querySelector(
    '[data-tour-id="exec.explainerPanel"] .chat-sourcecode-link',
  );
  if (!el) {
    console.warn('tour: no sourcecode link to click');
    return;
  }
  (el as HTMLElement).click();
}

function clickExplainerExpandBtn(): void {
  const el = document.querySelector('.pane-collapse-btn--explainer-expand');
  (el as HTMLElement | null)?.click();
}

function clickAgentsExpandBtn(): void {
  const el = document.querySelector('.pane-collapse-btn--exec-expand');
  (el as HTMLElement | null)?.click();
}

function waitForPythonIdle(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const isBusy = (s: string): boolean => s === 'pending' || s === 'running';
    let sawBusy = isBusy(executionPanelStore.getSnapshot().python.status);
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      clearTimeout(timer);
      resolve();
    };

    const unsubscribe = executionPanelStore.subscribe(() => {
      const status = executionPanelStore.getSnapshot().python.status;
      if (isBusy(status)) {
        sawBusy = true;
        return;
      }
      if (sawBusy) finish();
    });

    const timer = setTimeout(() => {
      if (!settled) {
        console.warn('tour: waitForPythonIdle timed out');
      }
      finish();
    }, timeoutMs);
  });
}

/**
 * Run one tour action.
 *
 * - `toggleModelDropdown` `{ open }` — open or close the model selection menu
 *   in the chat sidebar.
 * - `selectModel` `{ modelId }` — request a switch to the given local Gemma
 *   model id; user still confirms via the existing apply/cancel UI.
 * - `typeMessage` `{ text, clearFirst? }` — set the chat textarea value. If
 *   `clearFirst` is true the existing input is replaced; otherwise the new
 *   text replaces the field outright (the bridge call uses `setInput`).
 * - `pressStepButton` `{}` — synthesise a click on the chat Step button.
 * - `pressPlayButton` `{}` — synthesise a click on the chat Play button.
 * - `pressRunButton` `{}` — synthesise a click on the execution panel's
 *   "Run edited code" button. The button is disabled until the user has
 *   edited the code; in that case the click is a no-op.
 * - `toggleFeatureSelector` `{ open }` — open or close the feature selector
 *   menu in the execution panel.
 * - `setEnabledFeatures` `{ features }` — toggle one or more agent features
 *   (dataLoading, runSql, runPython, runReact, runSubAgent).
 * - `setPythonCode` `{ code }` — switch the execution panel to the Python tab
 *   and load `code` into the Python editor as an unsaved edit, so the Run
 *   button is enabled.
 * - `waitForLlmIdle` `{ timeoutMs? }` — wait until the LLM finishes streaming.
 *   Watches `executionPanelStore.llm.active` and resolves on the
 *   `false → true → false` edge so it doesn't return early when called
 *   immediately after `pressPlayButton` (the press is synchronous but
 *   `setLlmActive(true)` runs in the next microtask). Defaults to 60s; on
 *   timeout it resolves with a console warning so the tour doesn't hang.
 * - `waitForPythonIdle` `{ timeoutMs? }` — wait until the Python pane
 *   transitions out of `pending`/`running` after first entering one of those
 *   states, so a `pressRunButton` press has time to settle. Defaults to 60s;
 *   on timeout it resolves with a console warning.
 * - `newChat` `{}` — clear the chat history, abort any in-flight stream,
 *   reset the tool debugger, token usage, sub-agent store, and execution
 *   panel non-data panes. Same effect as pressing the New Chat button.
 * - `pressExplainerExpand` `{}` — maximize the Explainer pane during the
 *   tour. Releases the tour's force-expand on `exec` so the persisted
 *   collapse takes effect, then sets exec collapsed and clicks the
 *   `.pane-collapse-btn--explainer-expand` button so the user sees the
 *   button highlight.
 * - `pressAgentsExpand` `{}` — symmetric counterpart: re-claim
 *   force-expand on exec (in case it was released), release the tour's
 *   force-expand on `explainer`, set explainer collapsed, and click the
 *   `.pane-collapse-btn--exec-expand` button.
 * - `typeExplainerMessage` `{ text }` — set the active Explainer
 *   conversation entry's draft input via the explainer bridge.
 * - `sendExplainerMessage` `{}` — submit the active Explainer conversation
 *   entry. No-op when the send button would be disabled (streaming,
 *   unconfigured LLM, empty input).
 * - `waitForExplainerIdle` `{ timeoutMs? }` — wait until the active
 *   Explainer conversation finishes streaming. Watches the bridge's
 *   `isStreamingActive()` and resolves on the false→true→false edge.
 *   Defaults to 60s; on timeout it resolves with a console warning.
 * - `clickFirstSourcecodeLink` `{}` — click the first
 *   `.chat-sourcecode-link` button inside the Explainer panel. No-op with a
 *   console warning if none is rendered (model output is non-deterministic).
 * - `closeSourcecode` `{}` — close the Sourcecode overlay.
 */
export async function performAction<N extends ActionName>(
  name: N,
  params: ActionParams[N],
): Promise<void> {
  switch (name) {
    case 'toggleModelDropdown': {
      const p = params as ActionParams['toggleModelDropdown'];
      getChatBridge().setModelMenuOpen(p.open);
      return;
    }
    case 'selectModel': {
      const p = params as ActionParams['selectModel'];
      getChatBridge().requestModel(p.modelId);
      return;
    }
    case 'typeMessage': {
      const p = params as ActionParams['typeMessage'];
      getChatBridge().setInput(p.text);
      return;
    }
    case 'pressStepButton': {
      clickCutout('chat.stepButton');
      return;
    }
    case 'pressPlayButton': {
      clickCutout('chat.playButton');
      return;
    }
    case 'pressRunButton': {
      clickCutout('exec.runButton');
      return;
    }
    case 'toggleFeatureSelector': {
      const p = params as ActionParams['toggleFeatureSelector'];
      getExecBridge().setFeatureMenuOpen(p.open);
      return;
    }
    case 'setEnabledFeatures': {
      const p = params as ActionParams['setEnabledFeatures'];
      for (const [k, v] of Object.entries(p.features)) {
        if (typeof v === 'boolean') {
          agentFeatures.setFeature(k as FeatureKey, v);
        }
      }
      return;
    }
    case 'setPythonCode': {
      const p = params as ActionParams['setPythonCode'];
      getExecBridge().setPythonEditor(p.code);
      return;
    }
    case 'waitForLlmIdle': {
      const p = params as ActionParams['waitForLlmIdle'];
      await waitForLlmIdle(p.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
      return;
    }
    case 'waitForPythonIdle': {
      const p = params as ActionParams['waitForPythonIdle'];
      await waitForPythonIdle(p.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
      return;
    }
    case 'newChat': {
      getChatBridge().newChat();
      return;
    }
    case 'pressExplainerExpand': {
      clickExplainerExpandBtn();
      popForceExpand('tour', 'exec');
      setExecCollapsed(true);
      return;
    }
    case 'pressAgentsExpand': {
      clickAgentsExpandBtn();
      pushForceExpand('tour', 'exec');
      popForceExpand('tour', 'explainer');
      setExplainerCollapsed(true);
      return;
    }
    case 'typeExplainerMessage': {
      const p = params as ActionParams['typeExplainerMessage'];
      getExplainerBridge().setConversationInput(p.text);
      return;
    }
    case 'sendExplainerMessage': {
      getExplainerBridge().sendActiveConversation();
      return;
    }
    case 'waitForExplainerIdle': {
      const p = params as ActionParams['waitForExplainerIdle'];
      await waitForExplainerIdle(p.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
      return;
    }
    case 'clickFirstSourcecodeLink': {
      clickFirstSourcecodeLink();
      return;
    }
    case 'closeSourcecode': {
      closeSourcecodeOverlay();
      return;
    }
    default:
      return assertNever(name);
  }
}
