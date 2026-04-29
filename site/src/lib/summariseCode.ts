/**
 * Summarises a python/SQL snippet for the ExplainerPanel.
 *
 * IMPORTANT: This call is intentionally separate from the agent's chat
 * conversation. It must NOT be appended to the chat history, must NOT pass
 * any tool definitions, and must NOT share `streamChat`'s `conv` array. If
 * the model saw its own summaries on later turns it could be confused into
 * acting on them, and we would also pay for those tokens on every subsequent
 * tool round-trip. The only thing we share with the chat is the endpoint URL,
 * API key, and active model from `LLMConfig`.
 *
 * For the in-browser Gemma provider we drive the singleton `LlmInference`
 * directly (one-shot, no tool prompt) for the same isolation reason.
 */

import { callLLM } from './llm';
import { isLocalGemmaEndpoint } from '../types/llm';
import type { LLMConfig } from '../types/llm';

export type SummaryLanguage = 'python' | 'sql';

const SYSTEM_PROMPT =
  'You explain short code snippets in plain English for a non-technical reader. ' +
  'Reply with up to 3 sentences. Do not include code, markdown, or preamble.';

function buildUserPrompt(language: SummaryLanguage, code: string): string {
  const label = language === 'python' ? 'Python' : 'SQL';
  return (
    `Summarise this ${label} code into up to 3 sentences of English. ` +
    `Describe what the code does, not how it is written.\n\n` +
    '```' +
    language +
    '\n' +
    code +
    '\n```'
  );
}

export async function summariseCode(
  language: SummaryLanguage,
  code: string,
  config: LLMConfig,
  signal?: AbortSignal,
): Promise<string> {
  const endpoint = config.activeEndpoint;
  if (!endpoint) {
    throw new Error('No LLM endpoint selected.');
  }

  const userPrompt = buildUserPrompt(language, code);

  if (isLocalGemmaEndpoint(endpoint)) {
    return summariseWithLocalGemma(config, userPrompt, signal);
  }

  // `callLLM` issues a single, history-less request with no tools — exactly
  // what we need to keep this call out of the agent's chat context.
  const result = await callLLM(config, SYSTEM_PROMPT, userPrompt);
  if (signal?.aborted) {
    throw new DOMException('Summary aborted', 'AbortError');
  }
  return result.trim();
}

async function summariseWithLocalGemma(
  config: LLMConfig,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const { LOCAL_GEMMA_ENDPOINT } = await import('../types/llm');
  const { DEFAULT_LOCAL_GEMMA_ID, getLocalGemmaModel } = await import(
    './localLlm/models'
  );
  const { ensureLoaded, generate } = await import('./localLlm/llmService');

  const stored = config.models[LOCAL_GEMMA_ENDPOINT];
  const model = getLocalGemmaModel(stored) ?? getLocalGemmaModel(DEFAULT_LOCAL_GEMMA_ID);
  if (!model) {
    throw new Error(`Unknown local Gemma model id: ${stored ?? DEFAULT_LOCAL_GEMMA_ID}`);
  }

  await ensureLoaded(model.id);

  // Plain user-turn prompt — deliberately bypasses the tool-aware template
  // used by `streamLocalGemma` so the model has no tools available and no
  // shared history to lean on.
  const prompt =
    `<start_of_turn>user\n${SYSTEM_PROMPT}\n\n${userPrompt}<end_of_turn>\n` +
    `<start_of_turn>model\n`;

  const text = await generate({
    prompt,
    signal,
    onToken: () => {
      // Discard streaming tokens — the panel only consumes the final text.
    },
  });
  return text.trim();
}
