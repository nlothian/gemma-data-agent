import { runAgentTool } from '../agentTools';
import { isAbortError, type StreamChatOptions } from '../streamChat';
import { DEFAULT_LOCAL_GEMMA_ID, getLocalGemmaModel, type LocalGemmaId } from './models';
import { ensureLoaded, generate, cancel as cancelGenerate, sizeInTokens } from './llmService';
import {
  formatToolCallToken,
  parseStreamForToolCall,
  renderConversationForGemma,
  CHANNEL_OPEN,
  CHANNEL_CLOSE,
  type InternalMessage,
} from './toolPrompt';
import {
  createSplitterState,
  feedSplitter,
  flushSplitter,
  type SplitterEvent,
} from './thinkingChannelSplitter';
import { LOCAL_GEMMA_ENDPOINT } from '../../types/llm';

const MAX_TOOL_ITERATIONS = 5;
const THINKING_OPEN_MARKER = `${CHANNEL_OPEN}thought\n`;

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

  const thinkingEnabled = config.thinkingEnabled?.[LOCAL_GEMMA_ENDPOINT] ?? false;

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

      const prompt = renderConversationForGemma(systemPrompt, conv, tools ?? [], thinkingEnabled);

      // Two parallel buffers: `assistantTurnText` includes thought markers and
      // thought content for the UI; `assistantTurnHistory` strips them so past
      // turns re-fed to the model match the template's bare-past-turn rule.
      let assistantTurnText = '';
      let assistantTurnHistory = '';
      // Body-only buffer for the existing tool-call streaming parser.
      let toolBuffer = '';
      let pendingToolCall: { name: string; argsJson: string } | null = null;

      // When thinking is on, the very first iteration's prompt ends with an
      // open `<|channel>thought\n`, so the model resumes inside the thought
      // channel. Subsequent iterations after a tool response do NOT add a
      // fresh open, so they start `outside`.
      const splitter = createSplitterState(
        thinkingEnabled && iter === 0 ? 'in-thought' : 'outside',
      );
      // For the in-thought start, surface the (already-emitted-in-prompt)
      // open marker to the UI so the parser sees a complete thinking block.
      if (thinkingEnabled && iter === 0) {
        assistantTurnText += THINKING_OPEN_MARKER;
        emit(THINKING_OPEN_MARKER);
      }

      const handleEvent = (e: SplitterEvent): void => {
        if (pendingToolCall) return;
        if (e.kind === 'open') {
          assistantTurnText += THINKING_OPEN_MARKER;
          emit(THINKING_OPEN_MARKER);
          return;
        }
        if (e.kind === 'close') {
          assistantTurnText += CHANNEL_CLOSE;
          emit(CHANNEL_CLOSE);
          return;
        }
        if (e.kind === 'thought') {
          assistantTurnText += e.text;
          emit(e.text);
          return;
        }
        // body — route through the existing tool-call streaming parser so
        // partial `<|tool_call>` prefixes stay held back.
        toolBuffer += e.text;
        const parsed = parseStreamForToolCall(toolBuffer);
        if (parsed.emitText) {
          assistantTurnText += parsed.emitText;
          assistantTurnHistory += parsed.emitText;
          emit(parsed.emitText);
        }
        toolBuffer = parsed.rest;
        if (parsed.toolCall) {
          pendingToolCall = parsed.toolCall;
          try {
            cancelGenerate();
          } catch {
            // ignore
          }
        }
      };

      await generate({
        prompt,
        signal,
        onToken: (delta) => {
          if (pendingToolCall) return;
          for (const e of feedSplitter(splitter, delta)) {
            handleEvent(e);
            if (pendingToolCall) break;
          }
        },
      });

      // Drain the splitter at the end of generation.
      if (!pendingToolCall) {
        for (const e of flushSplitter(splitter)) {
          handleEvent(e);
          if (pendingToolCall) break;
        }
      }

      if (!pendingToolCall) {
        // Drain any remaining tool-buffer tail as plain text — when the
        // stream ends without a tool call, holdback chars are just text.
        if (toolBuffer) {
          assistantTurnText += toolBuffer;
          assistantTurnHistory += toolBuffer;
          emit(toolBuffer);
          toolBuffer = '';
        }
        reportUsage(prompt, assistantTurnText);
        onDone(accumulatedText);
        return;
      }

      reportUsage(prompt, assistantTurnText);

      const tc: { name: string; argsJson: string } = pendingToolCall;

      conv.push({
        role: 'assistant',
        content: assistantTurnHistory + formatToolCallToken(tc.name, tc.argsJson),
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
