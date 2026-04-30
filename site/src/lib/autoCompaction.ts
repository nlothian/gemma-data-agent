import * as toolDebugger from './toolDebugger';
import * as tokenUsageStore from './tokenUsageStore';
import * as executionPanelStore from './executionPanelStore';
import { compactConversation } from './compactConversation';
import { stripThinking } from './parseAssistantContent';
import { generateId } from './browser';
import {
  getContextWindowForEndpoint,
  shouldAutoCompact,
} from './contextWindow';
import type { ChatMessage } from '../types/chat';
import type { LLMConfig } from '../types/llm';
import type { TokenUsage } from './tokenUsageStore';

export const COMPACTION_TOOL_NAME = 'Compaction';

const COMPACTION_HEADER =
  '\n\n# Summary of earlier conversation (older turns were compacted)\n';

export interface CompactionSlice {
  toCompact: ChatMessage[];
  recent: ChatMessage[];
}

export interface ConvTurn {
  role: 'user' | 'assistant';
  content: string;
}

export function buildCompactionContext(messages: ChatMessage[]): string {
  const summaries = messages
    .filter((m) => m.kind === 'compaction')
    .map((m) => m.content);
  return summaries.length ? COMPACTION_HEADER + summaries.join('\n\n') : '';
}

export function mapMessagesForLLM(messages: ChatMessage[]): ConvTurn[] {
  return messages
    .filter(
      (m): m is ChatMessage & { role: 'user' | 'assistant' } =>
        !m.error && m.role !== 'system' && m.kind !== 'compaction',
    )
    .map((m) => ({
      role: m.role,
      content:
        m.role === 'assistant' && m.historyContent !== undefined
          ? m.historyContent
          : m.content,
    }));
}

export function buildCompactionSlice(
  messages: ChatMessage[],
): CompactionSlice | null {
  let lastRoundStart = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.kind !== 'compaction') {
      lastRoundStart = i;
      break;
    }
  }
  if (lastRoundStart <= 0) return null;
  const olderRange = messages.slice(0, lastRoundStart);
  const recent = messages.slice(lastRoundStart);
  const hasOldRound = olderRange.some(
    (m) => m.role === 'user' && m.kind !== 'compaction',
  );
  if (!hasOldRound) return null;
  const toCompact = [...olderRange, ...recent].map((m) =>
    m.role === 'assistant'
      ? {
          ...m,
          content: stripThinking(m.content),
          historyContent:
            m.historyContent !== undefined
              ? stripThinking(m.historyContent)
              : undefined,
        }
      : m,
  );
  return { toCompact, recent };
}

export interface RunCompactionDeps {
  config: LLMConfig;
  toCompact: ChatMessage[];
  recent: ChatMessage[];
  replaceMessages: (next: ChatMessage[]) => void;
  flush: () => void;
  setHighlightId: (id: string | null) => void;
  scrollToTop: () => void;
  /**
   * Optional: compute the post-compaction context size for the gauge.
   * Called with the message list as it will appear after the marker is
   * inserted. Return `null` if no client-side estimate is available — the
   * gauge will reset and repopulate from the next response's usage event.
   */
  estimatePostCompactionUsage?: (messages: ChatMessage[]) => TokenUsage | null;
}

export async function runCompaction(deps: RunCompactionDeps): Promise<void> {
  const { config, toCompact, recent, replaceMessages, flush, setHighlightId, scrollToTop } = deps;
  executionPanelStore.setLlmCompacting(true);
  try {
    const summary = await compactConversation({ config, toCompact });
    const marker: ChatMessage = {
      id: generateId(),
      role: 'user',
      kind: 'compaction',
      content: summary,
      createdAt: Date.now(),
    };
    const nextMessages = [marker, ...recent];
    replaceMessages(nextMessages);
    flush();
    tokenUsageStore.setTokenUsage(
      deps.estimatePostCompactionUsage?.(nextMessages) ?? null,
    );
    scrollToTop();
    setHighlightId(marker.id);
    setTimeout(() => setHighlightId(null), 5000);
  } catch (err) {
    console.warn('Compaction failed:', err);
  } finally {
    executionPanelStore.setLlmCompacting(false);
  }
}

export interface MaybeAutoCompactArgs {
  config: LLMConfig;
  messages: ChatMessage[];
  replaceMessages: (next: ChatMessage[]) => void;
  flush: () => void;
  setHighlightId: (id: string | null) => void;
  scrollToTop: () => void;
  signal: AbortSignal;
  estimatePostCompactionUsage?: (messages: ChatMessage[]) => TokenUsage | null;
}

export async function maybeAutoCompact(args: MaybeAutoCompactArgs): Promise<void> {
  const usage = tokenUsageStore.getSnapshot();
  if (!usage) return;
  const max = getContextWindowForEndpoint(args.config.activeEndpoint);
  const used = usage.input + usage.output;
  if (!shouldAutoCompact(used, max)) return;

  if (toolDebugger.getSnapshot().pending !== null) return;
  if (executionPanelStore.getSnapshot().llm.compacting) return;

  const slice = buildCompactionSlice(args.messages);
  if (!slice) return;

  if (toolDebugger.getSnapshot().mode === 'paused') {
    try {
      await toolDebugger.awaitToolGate(
        COMPACTION_TOOL_NAME,
        { messages: slice.toCompact },
        args.signal,
      );
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
      throw err;
    }
    if (args.signal.aborted) return;
  }

  await runCompaction({
    config: args.config,
    toCompact: slice.toCompact,
    recent: slice.recent,
    replaceMessages: args.replaceMessages,
    flush: args.flush,
    setHighlightId: args.setHighlightId,
    scrollToTop: args.scrollToTop,
    estimatePostCompactionUsage: args.estimatePostCompactionUsage,
  });
}
