export const LLM_CONFIG_STORAGE_KEY = 'haw.llm.config.v1';

export interface BuiltInProvider {
  id: 'openai' | 'anthropic' | 'openrouter';
  label: string;
  url: string;
}

export const BUILT_IN_PROVIDERS: readonly BuiltInProvider[] = [
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1' },
  { id: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com/v1' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
] as const;

export interface CustomEndpoint {
  id: string;
  label: string;
  url: string;
}

export interface LLMConfig {
  activeEndpoint: string | null;
  customEndpoints: CustomEndpoint[];
  apiKeys: Record<string, string>;
  models: Record<string, string>;
  thinkingEnabled: Record<string, boolean>;
}

export const EMPTY_LLM_CONFIG: LLMConfig = {
  activeEndpoint: null,
  customEndpoints: [],
  apiKeys: {},
  models: {},
  thinkingEnabled: {},
};

export const LOCAL_GEMMA_ENDPOINT = 'local://gemma';

export function isLocalGemmaEndpoint(url: string | null | undefined): boolean {
  return url === LOCAL_GEMMA_ENDPOINT;
}
