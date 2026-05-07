import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ACTION_NAMES,
  isActionName,
  performAction,
  type ActionName,
} from '../actions';
import {
  registerChatBridge,
  registerExecBridge,
  registerExplainerBridge,
} from '../bridge';
import * as agentFeatures from '../../agentFeaturesStore';

type AssertEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const _actionNamesCoverFullUnion: AssertEqual<
  (typeof ACTION_NAMES)[number],
  ActionName
> = true;
void _actionNamesCoverFullUnion;

describe('ACTION_NAMES', () => {
  it('contains exactly the expected runtime list', () => {
    expect([...ACTION_NAMES].sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it('isActionName accepts every entry and rejects garbage', () => {
    for (const n of ACTION_NAMES) {
      expect(isActionName(n)).toBe(true);
    }
    expect(isActionName('definitelyNotAnAction')).toBe(false);
  });
});

describe('performAction', () => {
  let chat: {
    setModelMenuOpen: ReturnType<typeof vi.fn>;
    setInput: ReturnType<typeof vi.fn>;
    requestModel: ReturnType<typeof vi.fn>;
    newChat: ReturnType<typeof vi.fn>;
  };
  let exec: {
    setFeatureMenuOpen: ReturnType<typeof vi.fn>;
    setPythonEditor: ReturnType<typeof vi.fn>;
  };
  let unregisterChat: () => void;
  let unregisterExec: () => void;

  beforeEach(() => {
    chat = {
      setModelMenuOpen: vi.fn(),
      setInput: vi.fn(),
      requestModel: vi.fn(),
      newChat: vi.fn(),
    };
    exec = { setFeatureMenuOpen: vi.fn(), setPythonEditor: vi.fn() };
    unregisterChat = registerChatBridge(chat);
    unregisterExec = registerExecBridge(exec);
  });

  afterEach(() => {
    unregisterChat();
    unregisterExec();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('toggleModelDropdown forwards to chat bridge', async () => {
    await performAction('toggleModelDropdown', { open: true });
    expect(chat.setModelMenuOpen).toHaveBeenCalledWith(true);
    await performAction('toggleModelDropdown', { open: false });
    expect(chat.setModelMenuOpen).toHaveBeenLastCalledWith(false);
  });

  it('selectModel forwards modelId to chat bridge', async () => {
    await performAction('selectModel', { modelId: 'gemma-2b' });
    expect(chat.requestModel).toHaveBeenCalledWith('gemma-2b');
  });

  it('typeMessage forwards text to chat bridge setInput', async () => {
    await performAction('typeMessage', { text: 'hi' });
    expect(chat.setInput).toHaveBeenCalledWith('hi');
  });

  it('newChat forwards to chat bridge newChat', async () => {
    await performAction('newChat', {});
    expect(chat.newChat).toHaveBeenCalledTimes(1);
  });

  it('toggleFeatureSelector forwards to exec bridge', async () => {
    await performAction('toggleFeatureSelector', { open: true });
    expect(exec.setFeatureMenuOpen).toHaveBeenCalledWith(true);
  });

  it('pressStepButton clicks the step cutout element', async () => {
    const click = vi.fn();
    const querySelector = vi.fn((sel: string) => {
      expect(sel).toBe('[data-tour-id="chat.stepButton"]');
      return { click } as unknown as Element;
    });
    vi.stubGlobal('document', { querySelector });
    await performAction('pressStepButton', {});
    expect(querySelector).toHaveBeenCalledWith('[data-tour-id="chat.stepButton"]');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('pressPlayButton clicks the play cutout element', async () => {
    const click = vi.fn();
    const querySelector = vi.fn(() => ({ click }) as unknown as Element);
    vi.stubGlobal('document', { querySelector });
    await performAction('pressPlayButton', {});
    expect(querySelector).toHaveBeenCalledWith('[data-tour-id="chat.playButton"]');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('pressRunButton clicks the run cutout element', async () => {
    const click = vi.fn();
    const querySelector = vi.fn(() => ({ click }) as unknown as Element);
    vi.stubGlobal('document', { querySelector });
    await performAction('pressRunButton', {});
    expect(querySelector).toHaveBeenCalledWith('[data-tour-id="exec.runButton"]');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('press*Button throws if the cutout element is missing', async () => {
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
    await expect(performAction('pressStepButton', {})).rejects.toThrow(
      /chat\.stepButton/,
    );
  });

  it('setPythonCode forwards the code to exec bridge setPythonEditor', async () => {
    await performAction('setPythonCode', { code: 'print("hi")' });
    expect(exec.setPythonEditor).toHaveBeenCalledWith('print("hi")');
  });

  it('setEnabledFeatures calls setFeature for each provided key', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    });
    const spy = vi.spyOn(agentFeatures, 'setFeature').mockImplementation(() => {});
    await performAction('setEnabledFeatures', {
      features: { runSql: false, runPython: true },
    });
    expect(spy).toHaveBeenCalledWith('runSql', false);
    expect(spy).toHaveBeenCalledWith('runPython', true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('explainer bridge actions', () => {
  let bridge: {
    setConversationInput: ReturnType<typeof vi.fn>;
    sendActiveConversation: ReturnType<typeof vi.fn>;
    subscribeStreaming: ReturnType<typeof vi.fn>;
    isStreamingActive: ReturnType<typeof vi.fn>;
  };
  let unregister: () => void;

  beforeEach(() => {
    bridge = {
      setConversationInput: vi.fn(),
      sendActiveConversation: vi.fn(),
      subscribeStreaming: vi.fn(() => () => {}),
      isStreamingActive: vi.fn(() => false),
    };
    unregister = registerExplainerBridge(bridge);
  });

  afterEach(() => {
    unregister();
  });

  it('typeExplainerMessage forwards text to setConversationInput', async () => {
    await performAction('typeExplainerMessage', { text: 'hello' });
    expect(bridge.setConversationInput).toHaveBeenCalledWith('hello');
  });

  it('sendExplainerMessage forwards to sendActiveConversation', async () => {
    await performAction('sendExplainerMessage', {});
    expect(bridge.sendActiveConversation).toHaveBeenCalledTimes(1);
  });

  it('clickFirstSourcecodeLink clicks scoped first link or warns', async () => {
    const click = vi.fn();
    const querySelector = vi.fn(() => ({ click }) as unknown as Element);
    vi.stubGlobal('document', { querySelector });
    await performAction('clickFirstSourcecodeLink', {});
    expect(querySelector).toHaveBeenCalledWith(
      '[data-tour-id="exec.explainerPanel"] .chat-sourcecode-link',
    );
    expect(click).toHaveBeenCalledTimes(1);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
    await performAction('clickFirstSourcecodeLink', {});
    expect(warn).toHaveBeenCalledWith('tour: no sourcecode link to click');
    warn.mockRestore();
  });
});

describe('waitForLlmIdle', () => {
  it('resolves on the false → true → false edge', async () => {
    const executionPanelStore = await import('../../executionPanelStore');
    executionPanelStore.setLlmActive(false);

    const promise = performAction('waitForLlmIdle', { timeoutMs: 5000 });

    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    executionPanelStore.setLlmActive(true);
    await Promise.resolve();
    expect(resolved).toBe(false);

    executionPanelStore.setLlmActive(false);
    await promise;
    expect(resolved).toBe(true);
  });

  it('resolves on timeout when llm.active never flips', async () => {
    vi.useFakeTimers();
    const executionPanelStore = await import('../../executionPanelStore');
    executionPanelStore.setLlmActive(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const promise = performAction('waitForLlmIdle', { timeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    await promise;

    expect(warn).toHaveBeenCalledWith('tour: waitForLlmIdle timed out');
    vi.useRealTimers();
    warn.mockRestore();
  });
});

describe('waitForPythonIdle', () => {
  it('resolves once python.status leaves pending/running', async () => {
    const executionPanelStore = await import('../../executionPanelStore');
    executionPanelStore.resetPanel();

    const promise = performAction('waitForPythonIdle', { timeoutMs: 5000 });

    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    executionPanelStore.setPending('python', 'print(1)');
    await Promise.resolve();
    expect(resolved).toBe(false);

    executionPanelStore.setRunning('python');
    await Promise.resolve();
    expect(resolved).toBe(false);

    executionPanelStore.setPythonResult({
      result: undefined,
      stdout: '1\n',
      stderr: '',
    });
    await promise;
    expect(resolved).toBe(true);
  });
});
