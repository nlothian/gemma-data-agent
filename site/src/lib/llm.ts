import type { LLMConfig } from '../types/llm';

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

interface AnthropicMessagesResponse {
  content?: { type: string; text?: string }[];
}

interface OpenAIModelsResponse {
  data?: { id?: unknown }[];
}

interface AnthropicModelsResponse {
  data?: { id?: unknown }[];
  has_more?: boolean;
}

export function formatErrorBody(body: string): string {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: unknown;
        metadata?: { raw?: unknown };
      };
    };
    const err = parsed?.error;
    const message = typeof err?.message === 'string' ? err.message : '';
    const raw = typeof err?.metadata?.raw === 'string' ? err.metadata.raw : '';
    if (message && raw) return `${message} — ${raw}`;
    if (raw) return raw;
    if (message) return message;
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return body;
}

export async function callLLM(
  config: LLMConfig,
  system: string,
  user: string,
): Promise<string> {
  const endpoint = config.activeEndpoint;
  if (!endpoint) {
    throw new Error('No LLM endpoint selected. Pick one in Settings.');
  }
  const apiKey = config.apiKeys[endpoint]?.trim();
  if (!apiKey) {
    throw new Error('No API key set for the active LLM endpoint.');
  }
  const model = config.models[endpoint];
  if (!model) {
    throw new Error('No model set for the active LLM endpoint.');
  }

  const isAnthropic = endpoint.includes('api.anthropic.com');
  const url = isAnthropic
    ? `${endpoint}/messages`
    : `${endpoint}/chat/completions`;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let body: string;

  if (isAnthropic) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    });
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
    body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
  }

  const response = await fetch(url, { method: 'POST', headers, body });
  if (!response.ok) {
    const rawBody = (await response.text().catch(() => '')).trim();
    const formatted = formatErrorBody(rawBody).slice(0, 500);
    throw new Error(`LLM ${response.status}: ${formatted || response.statusText}`);
  }

  const data: unknown = await response.json();

  if (isAnthropic) {
    const parsed = data as AnthropicMessagesResponse;
    const first = parsed.content?.[0];
    if (first && first.type === 'text' && typeof first.text === 'string') {
      return first.text;
    }
    throw new Error('Anthropic response did not contain text content.');
  }

  const parsed = data as OpenAIChatResponse;
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('OpenAI-compatible response did not contain message content.');
  }
  return content;
}

export async function fetchAvailableModels(
  endpoint: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  const isAnthropic = endpoint.includes('api.anthropic.com');
  const isOpenRouter = endpoint.includes('openrouter.ai');
  const trimmedKey = apiKey?.trim();

  const headers: Record<string, string> = {};
  let url: string;

  if (isAnthropic) {
    if (!trimmedKey) throw new Error('Missing API key');
    headers['x-api-key'] = trimmedKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    url = `${endpoint}/models?limit=1000`;
  } else if (isOpenRouter) {
    if (trimmedKey) headers['Authorization'] = `Bearer ${trimmedKey}`;
    url = `${endpoint}/models`;
  } else {
    if (!trimmedKey) throw new Error('Missing API key');
    headers['Authorization'] = `Bearer ${trimmedKey}`;
    url = `${endpoint}/models`;
  }

  const response = await fetch(url, { method: 'GET', headers, signal });
  if (!response.ok) {
    const rawBody = (await response.text().catch(() => '')).trim();
    const formatted = formatErrorBody(rawBody).slice(0, 500);
    throw new Error(`LLM models ${response.status}: ${formatted || response.statusText}`);
  }

  const data: unknown = await response.json();
  const parsed = data as OpenAIModelsResponse | AnthropicModelsResponse;
  if (!Array.isArray(parsed?.data)) {
    throw new Error('Malformed /models response');
  }

  if (isAnthropic && (parsed as AnthropicModelsResponse).has_more === true) {
    console.warn('Anthropic /models returned has_more=true; showing first page only.');
  }

  const ids = parsed.data
    .map((m) => m?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const deduped = Array.from(new Set(ids));
  deduped.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return deduped;
}
