import { describe, expect, it } from 'vitest';
import {
  registerCustomModel,
  resolveActiveLocalModelIdOrDefault,
} from './customModels';
import { DEFAULT_LOCAL_GEMMA_ID } from './models';
import { LOCAL_GEMMA_ENDPOINT, type LLMConfig } from '../../types/llm';

function cfg(modelId?: string): LLMConfig {
  return {
    activeEndpoint: LOCAL_GEMMA_ENDPOINT,
    customEndpoints: [],
    apiKeys: {},
    models: modelId ? { [LOCAL_GEMMA_ENDPOINT]: modelId } : {},
    thinkingEnabled: {},
  };
}

describe('resolveActiveLocalModelIdOrDefault', () => {
  it('passes through a known predefined id', () => {
    expect(resolveActiveLocalModelIdOrDefault(cfg('gemma-4-e4b'))).toBe(
      'gemma-4-e4b',
    );
  });

  it('falls back to the default when no model is configured', () => {
    expect(resolveActiveLocalModelIdOrDefault(cfg())).toBe(
      DEFAULT_LOCAL_GEMMA_ID,
    );
  });

  it('falls back to the default for an unresolvable (unregistered custom) id', () => {
    expect(
      resolveActiveLocalModelIdOrDefault(cfg('custom:not-registered')),
    ).toBe(DEFAULT_LOCAL_GEMMA_ID);
  });

  it('passes through a registered custom id', () => {
    const model = registerCustomModel(
      new File([new Uint8Array([1])], 'My-Model.task'),
    );
    expect(model.id).toBe('custom:My-Model');
    expect(resolveActiveLocalModelIdOrDefault(cfg(model.id))).toBe(model.id);
  });
});
