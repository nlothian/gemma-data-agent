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

/**
 * Tracks how many sub-agent runs are currently in flight on the stack.
 * `RunSubAgent` is forbidden inside another sub-agent (no recursion), so the
 * dispatcher refuses the call when this is non-zero. Belt-and-braces for the
 * prompt-level filter in `runSubAgent.ts`, which already drops the tool from
 * the sub-agent's system prompt and tool list.
 */
let subAgentDepth = 0;

export function getSubAgentDepth(): number {
  return subAgentDepth;
}

export function enterSubAgent(): void {
  subAgentDepth += 1;
}

export function exitSubAgent(): void {
  subAgentDepth = Math.max(0, subAgentDepth - 1);
}
