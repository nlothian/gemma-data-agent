import { runAgentTool } from '../agentTools';
import { isAbortError, type StreamChatOptions } from '../streamChat';
import { DEFAULT_LOCAL_GEMMA_ID } from './models';
import { resolveActiveLocalModel } from './customModels';
import { ensureLoaded, generate, sizeInTokens } from './llmService';
import {
  formatToolCallToken,
  formatToolResponseToken,
  parseStreamForToolCall,
  renderConversationForGemma,
  CHANNEL_OPEN,
  CHANNEL_CLOSE,
  TOOL_CALL_OPEN,
  STRING_DELIM,
  type InternalMessage,
} from './toolPrompt';
import {
  setLlmPreparingToolCall,
  setStreamingSource,
} from '../executionPanelStore';
import {
  createSplitterState,
  feedSplitter,
  flushSplitter,
  type SplitterEvent,
} from './thinkingChannelSplitter';
import { LOCAL_GEMMA_ENDPOINT } from '../../types/llm';

const MAX_TOOL_ITERATIONS = 5;
const THINKING_OPEN_MARKER = `${CHANNEL_OPEN}thought\n`;

/**
 * Inspect the held-back tool-call buffer (`parsed.rest`) and decide what the
 * throbber should advertise. Returns `null` if the buffer doesn't yet contain
 * a complete `<|tool_call>` opener (so we're still in plain-text holdback or
 * idle), `{ name: null }` if the opener is present but the `call:NAME{`
 * prefix isn't parseable yet, and `{ name }` once the name is available.
 */
function extractPreparingToolCall(
  buffer: string,
): { name: string | null } | null {
  if (!buffer.startsWith(TOOL_CALL_OPEN)) return null;
  const after = buffer.slice(TOOL_CALL_OPEN.length);
  const callPrefix = 'call:';
  if (!after.startsWith(callPrefix)) {
    // Opener present but we don't even have `call:` yet — model is still
    // emitting the prefix.
    return { name: null };
  }
  const rest = after.slice(callPrefix.length);
  // Name runs up to `{` (start of body) or whitespace.
  const match = rest.match(/^([A-Za-z0-9_]+)/);
  if (!match) return { name: null };
  return { name: match[1] };
}

/**
 * Tools whose body has a single "main" code/sql field that we want to stream
 * into the corresponding pane's editor as it's generated. The key is the
 * argument name in the Gemma tool-call body (e.g. `code:<|"|>...<|"|>`).
 */
const STREAMING_FIELDS: Record<string, { kind: 'python' | 'sql' | 'react'; key: string }> = {
  RunPython: { kind: 'python', key: 'code' },
  RunSQL: { kind: 'sql', key: 'sql' },
  RunReact: { kind: 'react', key: 'code' },
};

/**
 * Pull the partial source string for a streaming tool-call body. Returns the
 * pane kind and the substring between the opening `<key>:<|"|>` and either
 * the closing `<|"|>` (if it has arrived) or the current end of the buffer.
 * Returns `null` if the body isn't yet shaped like a recognised streaming
 * tool, or the relevant field hasn't started yet.
 */
function extractStreamingCode(
  buffer: string,
): { kind: 'python' | 'sql' | 'react'; source: string } | null {
  if (!buffer.startsWith(TOOL_CALL_OPEN)) return null;
  const after = buffer.slice(TOOL_CALL_OPEN.length);
  const callPrefix = 'call:';
  if (!after.startsWith(callPrefix)) return null;
  const rest = after.slice(callPrefix.length);
  const nameMatch = rest.match(/^([A-Za-z0-9_]+)\{/);
  if (!nameMatch) return null;
  const spec = STREAMING_FIELDS[nameMatch[1]];
  if (!spec) return null;
  const body = rest.slice(nameMatch[0].length);
  const opener = `${spec.key}:${STRING_DELIM}`;
  const openerIdx = body.indexOf(opener);
  if (openerIdx === -1) return null;
  const valStart = openerIdx + opener.length;
  const closeIdx = body.indexOf(STRING_DELIM, valStart);
  const source = closeIdx === -1 ? body.slice(valStart) : body.slice(valStart, closeIdx);
  return { kind: spec.kind, source };
}

export async function streamLocalGemma(opts: StreamChatOptions): Promise<void> {
  const { config, messages, tools, signal, onToken, onHistoryDelta, onDone, onError, onUsage } =
    opts;
  const emitHistory = (delta: string): void => {
    if (delta && onHistoryDelta) onHistoryDelta(delta);
  };

  // Token usage is reported once per turn, only after `await generate()` has
  // resolved. `sizeInTokens` re-enters the same MediaPipe `LlmInference` graph
  // as `generateResponse`, so calling it while a decode is in flight (e.g.
  // from inside an `onToken` callback) pushes packets through the
  // `token_cost_in` stream and desyncs its timestamp counter, surfacing as
  //   "Packet timestamp mismatch ... token_cost_in"
  // on the next decode. Calling it between turns is safe.
  const reportUsage = (promptText: string, outputText: string): void => {
    if (!onUsage) return;
    const input = sizeInTokens(promptText);
    const output = sizeInTokens(outputText);
    if (input === null && output === null) return;
    onUsage({ input: input ?? 0, output: output ?? 0 });
  };

  const modelId = config.models[LOCAL_GEMMA_ENDPOINT] ?? DEFAULT_LOCAL_GEMMA_ID;
  if (!resolveActiveLocalModel(modelId)) {
    onError(new Error(`Unknown local model id: ${modelId}`));
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
          emitHistory(parsed.emitText);
        }
        toolBuffer = parsed.rest;
        if (parsed.toolCall) {
          pendingToolCall = parsed.toolCall;
          // Once the call is fully parsed, the agent dispatch will switch
          // the relevant pane to pending and the throbber will surface
          // "Running Python" / "Running SQL" instead.
          setLlmPreparingToolCall(null);
          // Don't call `cancelGenerate()` here. Cancelling MediaPipe mid-decode
          // leaves its CalculatorGraph in a state where the next
          // `generateResponse` fails with a `token_cost_in` packet-timestamp
          // mismatch. Subsequent tokens are already discarded by the
          // `pendingToolCall` short-circuit in `onToken` below, so letting the
          // decode finish naturally costs only a few extra tokens of compute.
        } else {
          setLlmPreparingToolCall(extractPreparingToolCall(toolBuffer));
          const streaming = extractStreamingCode(toolBuffer);
          if (streaming) {
            setStreamingSource(streaming.kind, streaming.source);
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
          emitHistory(toolBuffer);
          toolBuffer = '';
        }
        reportUsage(prompt, assistantTurnText);
        onDone(accumulatedText);
        return;
      }

      reportUsage(prompt, assistantTurnText);

      const tc: { name: string; argsJson: string } = pendingToolCall;
      const toolCallToken = formatToolCallToken(tc.name, tc.argsJson);

      conv.push({
        role: 'assistant',
        content: assistantTurnHistory + toolCallToken,
      });
      emitHistory(toolCallToken);

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
      emitHistory(formatToolResponseToken(tc.name, resultStr));

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
