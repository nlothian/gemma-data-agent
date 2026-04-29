import { runAgentTool } from '../agentTools';
import { isAbortError, type StreamChatOptions } from '../streamChat';
import { DEFAULT_LOCAL_GEMMA_ID, getLocalGemmaModel, type LocalGemmaId } from './models';
import { ensureLoaded, generate, cancel as cancelGenerate, sizeInTokens } from './llmService';
import {
  formatToolCallToken,
  parseStreamForToolCall,
  renderConversationForGemma,
  type InternalMessage,
} from './toolPrompt';
import { LOCAL_GEMMA_ENDPOINT } from '../../types/llm';

const MAX_TOOL_ITERATIONS = 5;

export async function streamLocalGemma(opts: StreamChatOptions): Promise<void> {
  const { config, messages, tools, signal, onToken, onDone, onError, onUsage } = opts;

  const reportUsage = (promptText: string, outputText: string): void => {
    if (!onUsage) return;
    const input = sizeInTokens(promptText);
    const output = sizeInTokens(outputText);
    if (input === null && output === null) return;
    onUsage({ input: input ?? 0, output: output ?? 0 });
  };

  const modelId =
    (config.models[LOCAL_GEMMA_ENDPOINT] as LocalGemmaId | undefined) ??
    DEFAULT_LOCAL_GEMMA_ID;
  if (!getLocalGemmaModel(modelId)) {
    onError(new Error(`Unknown local Gemma model id: ${modelId}`));
    return;
  }

  let accumulatedText = '';
  const emit = (delta: string): void => {
    if (!delta) return;
    accumulatedText += delta;
    onToken(delta);
  };

  const systemPrompt = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
    .trim();

  const conv: InternalMessage[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) =>
      m.role === 'assistant'
        ? { role: 'assistant' as const, content: m.content }
        : { role: 'user' as const, content: m.content },
    );

  try {
    await ensureLoaded(modelId);

    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      if (signal?.aborted) {
        onDone(accumulatedText);
        return;
      }

      const prompt = renderConversationForGemma(systemPrompt, conv, tools ?? []);

      let buffer = '';
      let assistantTurnText = '';
      let pendingToolCall: { name: string; argsJson: string } | null = null;

      await generate({
        prompt,
        signal,
        onToken: (delta) => {
          if (pendingToolCall) return;
          buffer += delta;
          const parsed = parseStreamForToolCall(buffer);
          if (parsed.emitText) {
            assistantTurnText += parsed.emitText;
            emit(parsed.emitText);
          }
          buffer = parsed.rest;
          if (parsed.toolCall) {
            pendingToolCall = parsed.toolCall;
            try {
              cancelGenerate();
            } catch {
              // ignore
            }
          }
        },
      });

      if (!pendingToolCall) {
        if (buffer) {
          assistantTurnText += buffer;
          emit(buffer);
        }
        reportUsage(prompt, assistantTurnText);
        onDone(accumulatedText);
        return;
      }

      reportUsage(prompt, assistantTurnText);

      const tc: { name: string; argsJson: string } = pendingToolCall;

      conv.push({
        role: 'assistant',
        content: assistantTurnText + formatToolCallToken(tc.name, tc.argsJson),
      });

      if (signal?.aborted) {
        onDone(accumulatedText);
        return;
      }

      let inputObj: unknown;
      try {
        inputObj = JSON.parse(tc.argsJson);
      } catch {
        inputObj = {};
      }
      emit(`\n\n→ ${tc.name}(${tc.argsJson || '{}'})\n`);
      const result = await runAgentTool(tc.name, inputObj, signal);
      const resultStr = JSON.stringify(result);
      emit(`← ${resultStr}\n\n`);

      conv.push({
        role: 'tool',
        toolName: tc.name,
        content: resultStr,
      });
    }

    emit('\n\n[Reached max tool iterations.]');
    onDone(accumulatedText);
  } catch (err) {
    if (isAbortError(err)) {
      onDone(accumulatedText);
      return;
    }
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
