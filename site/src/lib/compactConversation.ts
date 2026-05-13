// THIS MODULE MAKES AN ISOLATED API CALL — IT IS NOT PART OF THE CHAT THREAD.
//
// It runs a one-shot, non-streaming request to the user's currently selected
// model with `compactionPrompt.md` as the system prompt and the older portion
// of the conversation as a single serialised user message. The result is a
// plain summary string that gets stored back into chat history as a single
// `kind: 'compaction'` message.
//
// Do NOT route this through `streamChat.ts`: that path injects the agent
// system prompt and tool definitions, neither of which apply here. Do NOT
// append the request or response to chat history — only the summary string
// belongs there.

import { callLLM } from './llm';
import { generate as generateLocal, ensureLoaded } from './localLlm/llmService';
import { stripCompactedMarker, stripThinking } from './parseAssistantContent';
import type { ChatMessage } from '../types/chat';
import { isLocalGemmaEndpoint, LOCAL_GEMMA_ENDPOINT, type LLMConfig } from '../types/llm';
import { DEFAULT_LOCAL_GEMMA_ID } from './localLlm/models';
import { resolveActiveLocalModel } from './localLlm/customModels';
import compactionPromptText from '../prompts/compactionPrompt.md?raw';

export interface CompactConversationArgs {
  config: LLMConfig;
  toCompact: ChatMessage[];
  signal?: AbortSignal;
}

export async function compactConversation(
  args: CompactConversationArgs,
): Promise<string> {
  const { config, toCompact, signal } = args;
  const endpoint = config.activeEndpoint;
  if (!endpoint) throw new Error('No LLM endpoint selected.');

  const userPayload = serialiseConversation(toCompact);
  if (!userPayload.trim()) throw new Error('Nothing to compact.');

  if (isLocalGemmaEndpoint(endpoint)) {
    const requested = config.models[LOCAL_GEMMA_ENDPOINT] ?? DEFAULT_LOCAL_GEMMA_ID;
    const modelId = resolveActiveLocalModel(requested) ? requested : DEFAULT_LOCAL_GEMMA_ID;
    await ensureLoaded(modelId);
    const prompt =
      compactionPromptText + '\n\n' + userPayload + '\n\nSummary:\n';
    const result = await generateLocal({
      prompt,
      signal,
      onToken: () => {
        // Discarded — the summary is captured via the resolved value.
      },
    });
    return result.trim();
  }

  return (await callLLM(config, compactionPromptText, userPayload)).trim();
}

export function serialiseConversation(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.kind === 'compaction') {
      parts.push(`[earlier summary]\n${m.content}`);
      continue;
    }
    if (m.role === 'user') {
      parts.push(`USER: ${m.content}`);
    } else if (m.role === 'assistant') {
      const replay = m.historyContent ?? m.content;
      parts.push(`ASSISTANT: ${stripCompactedMarker(stripThinking(replay))}`);
    }
  }
  return parts.join('\n\n');
}
