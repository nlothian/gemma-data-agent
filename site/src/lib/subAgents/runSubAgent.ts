/**
 * SubAgent orchestrator.
 *
 * A SubAgent is an isolated LLM call that runs alongside the main thread.
 * Its job is to keep expensive context (large intermediate analyses, long
 * tool transcripts) out of the parent conversation while still letting the
 * parent benefit from the result.
 *
 * Entry point: the main agent calls the `RunSubAgent` tool — see
 * `agentTools.ts`. The parent context summary is produced via the existing
 * `compactConversation` path so we don't drag the whole transcript into the
 * sub-thread.
 */

import { generateId } from '../browser';
import {
  buildAgentSystemPrompt,
  buildAgentTools,
  type AgentPromptFeatures,
} from '../agentTools';
import { compactConversation } from '../compactConversation';
import { streamChat, type StreamChatMessage } from '../streamChat';
import type { LLMConfig } from '../../types/llm';
import * as subAgentStore from './store';
import type { ChatMessage } from '../../types/chat';

export interface RunSubAgentArgs {
  prompt: string;
  taskLabel?: string;
  config: LLMConfig;
  /** Messages from the parent thread to summarise into the SubAgent's seed context. */
  parentMessages: ChatMessage[];
  features: AgentPromptFeatures;
  signal?: AbortSignal;
  /**
   * Optional pre-created run id. When supplied, the run, the user prompt
   * message, and the assistant placeholder are assumed to already be in the
   * store — see `prepareSubAgentRun`. Used so the prompt is visible in the
   * SubAgents tab during the pre-execution Step/Play pause.
   */
  runId?: string;
}

export interface PrepareSubAgentRunArgs {
  prompt: string;
  taskLabel?: string;
}

/**
 * Register the sub-agent run + its prompt in the store before the gated
 * execution begins, so the SubAgents tab shows the instructions during the
 * Step/Play pause instead of staying blank until the user resumes.
 */
export function prepareSubAgentRun(args: PrepareSubAgentRunArgs): string {
  const label = (args.taskLabel || args.prompt || 'SubAgent').slice(0, 80);
  const runId = subAgentStore.startRun({ label });

  const userMsg: ChatMessage = {
    id: generateId(),
    role: 'user',
    content: args.prompt,
    createdAt: Date.now(),
  };
  const assistantMsg: ChatMessage = {
    id: generateId(),
    role: 'assistant',
    content: '',
    createdAt: Date.now(),
  };
  subAgentStore.appendMessage(runId, userMsg);
  subAgentStore.appendMessage(runId, assistantMsg);
  return runId;
}

export interface SubAgentResultOk {
  text: string;
}

export interface SubAgentResultErr {
  error: string;
}

export type RunSubAgentResult = SubAgentResultOk | SubAgentResultErr;

const SUBAGENT_SYSTEM_HEADER =
  'You are a sub-agent invoked by the main agent in an isolated context. ' +
  'Answer concisely and return your final result as plain text — do not ' +
  'address the user directly.';

export async function runSubAgent(
  args: RunSubAgentArgs,
): Promise<RunSubAgentResult> {
  const { prompt, config, parentMessages, features, signal } = args;

  const runId = args.runId ?? prepareSubAgentRun(args);

  // Sub-agents must not be able to spawn further sub-agents. Disabling the
  // `runSubAgent` feature drops it from BOTH the system prompt (so the sub
  // isn't told the tool exists) and the tool-spec list, via the normal
  // featureKey gating.
  const subFeatures: AgentPromptFeatures = { ...features, runSubAgent: false };

  try {
    const summary = await summariseParent(parentMessages, config, signal);
    const baseSystem = buildAgentSystemPrompt(subFeatures);
    const systemPrompt =
      SUBAGENT_SYSTEM_HEADER +
      '\n\n' +
      baseSystem +
      (summary ? `\n\n## Parent context\n${summary}` : '');

    const finalText = await runTextSubAgent({
      systemPrompt,
      prompt,
      config,
      features: subFeatures,
      signal,
      runId,
    });

    subAgentStore.setStatus(runId, 'done');
    return { text: finalText };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? '');
    subAgentStore.setStatus(runId, 'error', message);
    return { error: message };
  }
}

async function summariseParent(
  parentMessages: ChatMessage[],
  config: LLMConfig,
  signal: AbortSignal | undefined,
): Promise<string> {
  // Skip the compaction call entirely on an empty parent — `compactConversation`
  // throws "Nothing to compact." in that case and the SubAgent shouldn't fail
  // just because there's no prior context to summarise.
  const hasContent = parentMessages.some(
    (m) => m.role !== 'system' && (m.content ?? '').trim().length > 0,
  );
  if (!hasContent) return '';
  try {
    return await compactConversation({ config, toCompact: parentMessages, signal });
  } catch (err) {
    if (err instanceof Error && err.message === 'Nothing to compact.') return '';
    throw err;
  }
}

async function runTextSubAgent(opts: {
  systemPrompt: string;
  prompt: string;
  config: LLMConfig;
  features: AgentPromptFeatures;
  signal?: AbortSignal;
  runId: string;
}): Promise<string> {
  const { systemPrompt, prompt, config, features, signal, runId } = opts;
  const messages: StreamChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ];

  const tools = buildAgentTools(features);

  return new Promise<string>((resolve, reject) => {
    void streamChat({
      config,
      messages,
      tools,
      signal,
      onToken: (delta) => {
        subAgentStore.updateLastAssistant(runId, delta);
      },
      onHistoryDelta: () => {
        // Not persisted — the SubAgent's UI uses `content` directly and the
        // run is discarded on New Conversation / reload anyway.
      },
      onUsage: () => {
        // Skip token reporting — sub-agent usage is intentionally separate
        // from the parent's pressure gauge.
      },
      onDone: (full) => resolve(full),
      onError: (err) => reject(err),
    });
  });
}
