import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summariseCode } from './summariseCode';
import { LOCAL_GEMMA_ENDPOINT, type LLMConfig } from '../types/llm';

const ANTHROPIC_CONFIG: LLMConfig = {
  activeEndpoint: 'https://api.anthropic.com/v1',
  customEndpoints: [],
  apiKeys: { 'https://api.anthropic.com/v1': 'sk-test' },
  models: { 'https://api.anthropic.com/v1': 'claude-test' },
  thinkingEnabled: {},
};

const OPENAI_CONFIG: LLMConfig = {
  activeEndpoint: 'https://api.openai.com/v1',
  customEndpoints: [],
  apiKeys: { 'https://api.openai.com/v1': 'sk-test' },
  models: { 'https://api.openai.com/v1': 'gpt-test' },
  thinkingEnabled: {},
};

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOnce(payload: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('summariseCode (cloud endpoints)', () => {
  it('throws when no endpoint is configured', async () => {
    const empty: LLMConfig = {
      activeEndpoint: null,
      customEndpoints: [],
      apiKeys: {},
      models: {},
      thinkingEnabled: {},
    };
    await expect(summariseCode('python', 'x = 1', empty)).rejects.toThrow(/endpoint/i);
  });

  it('hits Anthropic /messages with a single isolated user message', async () => {
    const spy = mockFetchOnce({ content: [{ type: 'text', text: 'It sets x to 1.' }] });
    const result = await summariseCode('python', 'x = 1', ANTHROPIC_CONFIG);
    expect(result).toBe('It sets x to 1.');

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse((init as RequestInit).body as string);

    // Isolation invariants — these MUST hold so the call cannot pollute the
    // chat conversation.
    expect(body.tools).toBeUndefined();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ role: 'user' });
    expect(body.messages[0].content).toContain('x = 1');
    expect(body.messages[0].content).toMatch(/3 sentences/i);
    expect(body.messages[0].content).toMatch(/python/i);
    expect(body.model).toBe('claude-test');
  });

  it('hits OpenAI-compatible /chat/completions with a single user message', async () => {
    const spy = mockFetchOnce({
      choices: [{ message: { content: 'Selects literal 1.' } }],
    });
    const result = await summariseCode('sql', 'SELECT 1', OPENAI_CONFIG);
    expect(result).toBe('Selects literal 1.');

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);

    expect(body.tools).toBeUndefined();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain('SELECT 1');
    expect(body.messages[1].content).toMatch(/sql/i);
    expect(body.model).toBe('gpt-test');
  });

  it('uses the active model from config (not hardcoded)', async () => {
    const config: LLMConfig = {
      ...OPENAI_CONFIG,
      models: { 'https://api.openai.com/v1': 'gpt-custom' },
    };
    const spy = mockFetchOnce({ choices: [{ message: { content: 'ok' } }] });
    await summariseCode('python', 'pass', config);
    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('gpt-custom');
  });

  it('rejects after the request when the abort signal has fired', async () => {
    mockFetchOnce({ content: [{ type: 'text', text: 'ok' }] });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      summariseCode('python', 'x', ANTHROPIC_CONFIG, ctrl.signal),
    ).rejects.toThrow(/abort/i);
  });

  it('routes local Gemma to the in-browser path (no fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.doMock('./localLlm/llmService', () => ({
      ensureLoaded: vi.fn().mockResolvedValue(undefined),
      generate: vi.fn().mockResolvedValue('Gemma summary.'),
      sizeInTokens: () => null,
      cancel: () => {},
    }));

    // Re-import after the mock is registered so the dynamic import inside
    // summariseCode picks up the stub.
    vi.resetModules();
    const fresh = await import('./summariseCode');
    const config: LLMConfig = {
      activeEndpoint: LOCAL_GEMMA_ENDPOINT,
      customEndpoints: [],
      apiKeys: {},
      models: {},
      thinkingEnabled: {},
    };
    const result = await fresh.summariseCode('python', 'print("hi")', config);
    expect(result).toBe('Gemma summary.');
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.doUnmock('./localLlm/llmService');
  });
});
