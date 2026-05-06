/**
 * Bridge between `ChatSidebar` (which owns chat history, agent features, and
 * config) and the LLM-facing `RunSubAgent` tool dispatcher in `agentTools.ts`.
 *
 * `runAgentTool` runs deep inside the streaming loop and has no React state
 * to read from. Before kicking off a stream, `ChatSidebar` calls
 * `setSubAgentContext` so any `RunSubAgent` tool calls the model emits during
 * that stream see the current snapshot.
 */

import type { LLMConfig } from '../../types/llm';
import type { AgentPromptFeatures } from '../agentTools';
import type { ChatMessage } from '../../types/chat';

export interface SubAgentContext {
  config: LLMConfig;
  parentMessages: ChatMessage[];
  features: AgentPromptFeatures;
}

let current: SubAgentContext | null = null;

export function setSubAgentContext(ctx: SubAgentContext | null): void {
  current = ctx;
}

export function getSubAgentContext(): SubAgentContext | null {
  return current;
}
