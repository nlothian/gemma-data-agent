import { formatErrorBody } from './llm';
import type { LLMConfig } from '../types/llm';
import { isLocalGemmaEndpoint } from '../types/llm';
import { runAgentTool, type AgentToolSpec } from './agentTools';
import { clampToolResultSize } from './toolResultLimits';

export interface StreamChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface TokenUsageReport {
  input: number;
  output: number;
  /** Cumulative output tokens per second of decode time for this turn,
   * excluding tool-dispatch latency between iterations. */
  tps?: number;
}

export type ToolDispatcher = (
  name: string,
  input: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface StreamChatOptions {
  config: LLMConfig;
  messages: StreamChatMessage[];
  tools?: AgentToolSpec[];
  /**
   * Optional override for tool-call dispatch. Defaults to `runAgentTool` (the
   * main agent's gated tool registry). The Explainer Conversation passes its
   * own non-gated dispatcher so its read-only research tools (GrepCodebase,
   * ReadLines, HighlightSourcecode) don't suspend on the Step/Play gate.
   */
  toolDispatcher?: ToolDispatcher;
  signal?: AbortSignal;
  onToken: (delta: string) => void;
  /**
   * Optional companion to `onToken` that receives a parallel stream of
   * replay-format text — what should be persisted as the assistant's
   * `historyContent` and fed back to the model on the next turn. Currently
   * only the local-Gemma path emits this; the cloud-API paths leave it
   * unset because their `onToken` text is already replay-safe.
   */
  onHistoryDelta?: (delta: string) => void;
  onDone: (full: string) => void;
  onError: (err: Error) => void;
  onUsage?: (usage: TokenUsageReport) => void;
  /** Fired when streamLocalGemma compacts mid-loop to fit a tool result;
   * insert a `kind: 'compaction'` marker into visible history. */
  onMidStreamCompaction?: (info: { summary: string }) => void;
  /** Fired when the agent loop stops because the tool iteration budget ran
   * out. The UI flags the assistant message so it can render a Continue
   * button on that bubble. */
  onMaxIterationsReached?: () => void;
}

const MAX_TOOL_ITERATIONS = 5;

interface ToolUse {
  id: string;
  name: string;
  inputJson: string;
}

interface TurnResult {
  text: string;
  toolUses: ToolUse[];
  stopReason: string;
  /** Wall-clock ms between the first text/tool delta and the last one in
   * this turn — the decode-only window, excluding network connect time
   * and the gap before any tokens arrive. */
  decodeMs: number;
  /** Output tokens reported by the provider for this turn (cumulative
   * across SSE usage events within one runOneTurn call). */
  outputTokens: number;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string };

interface InternalMessage {
  role: 'user' | 'assistant' | 'system';
  content: string | ContentBlock[];
}

type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; index: number; id: string; name: string }
  | { type: 'tool_delta'; index: number; partialJson: string }
  | { type: 'stop'; reason: string }
  | { type: 'usage'; input?: number; output?: number };

export async function streamChat(opts: StreamChatOptions): Promise<void> {
  const {
    config,
    messages,
    tools,
    toolDispatcher,
    signal,
    onToken,
    onDone,
    onError,
    onUsage,
    onMaxIterationsReached,
  } = opts;
  const dispatch: ToolDispatcher = toolDispatcher ?? runAgentTool;

  let endpoint: string;
  try {
    endpoint = requireString(config.activeEndpoint, 'No LLM endpoint selected. Pick one in Settings.');
  } catch (err) {
    onError(err as Error);
    return;
  }

  if (isLocalGemmaEndpoint(endpoint)) {
    const { streamLocalGemma } = await import('./localLlm/streamLocalGemma');
    return streamLocalGemma(opts);
  }

  let apiKey: string;
  let model: string;
  try {
    apiKey = requireString(config.apiKeys[endpoint]?.trim(), 'No API key set for the active LLM endpoint.');
    model = requireString(config.models[endpoint], 'No model set for the active LLM endpoint.');
  } catch (err) {
    onError(err as Error);
    return;
  }

  const isAnthropic = endpoint.includes('api.anthropic.com');
  const systemText = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const conv: InternalMessage[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  let accumulatedText = '';
  const emit = (delta: string): void => {
    accumulatedText += delta;
    onToken(delta);
  };

  let lastInput = 0;
  let lastOutput = 0;
  // Cumulative across iterations so the displayed tok/s reflects all decode
  // work in this turn, with tool-dispatch gaps between iterations excluded.
  let totalDecodeMs = 0;
  let totalOutputTokens = 0;
  const reportUsage = (u: { input?: number; output?: number }): void => {
    if (typeof u.input === 'number' && u.input > 0) lastInput = u.input;
    if (typeof u.output === 'number' && u.output >= 0) lastOutput = u.output;
    const tps =
      totalDecodeMs > 0 ? totalOutputTokens / (totalDecodeMs / 1000) : undefined;
    onUsage?.({ input: lastInput, output: lastOutput, tps });
  };

  try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      if (signal?.aborted) {
        onDone(accumulatedText);
        return;
      }

      const turn = await runOneTurn({
        endpoint,
        apiKey,
        model,
        isAnthropic,
        systemText,
        conv,
        tools,
        signal,
        onText: emit,
        onUsage: reportUsage,
      });
      totalDecodeMs += turn.decodeMs;
      totalOutputTokens += turn.outputTokens;
      // Re-emit usage now that this iteration's decode window has closed,
      // so tok/s reflects the just-finished decode (the SSE usage event may
      // have arrived before decodeMs was finalised).
      reportUsage({});

      if (turn.toolUses.length === 0) {
        onDone(accumulatedText);
        return;
      }

      const assistantBlocks: ContentBlock[] = [];
      if (turn.text) assistantBlocks.push({ type: 'text', text: turn.text });
      for (const tu of turn.toolUses) {
        assistantBlocks.push({
          type: 'tool_use',
          id: tu.id,
          name: tu.name,
          input: safeParseJson(tu.inputJson),
        });
      }
      conv.push({ role: 'assistant', content: assistantBlocks });

      const resultBlocks: ContentBlock[] = [];
      for (const tu of turn.toolUses) {
        if (signal?.aborted) {
          onDone(accumulatedText);
          return;
        }
        const input = safeParseJson(tu.inputJson);
        emit(`\n\n→ ${tu.name}(${tu.inputJson || '{}'})\n`);
        const result = await dispatch(tu.name, input, signal);
        const resultStr = clampToolResultSize(tu.name, JSON.stringify(result));
        emit(`← ${resultStr}\n\n`);
        resultBlocks.push({ type: 'tool_result', toolUseId: tu.id, content: resultStr });
      }
      conv.push({ role: 'user', content: resultBlocks });
    }

    emit('\n\nReached max tool iterations');
    onMaxIterationsReached?.();
    onDone(accumulatedText);
  } catch (err) {
    if (isAbortError(err)) {
      onDone(accumulatedText);
      return;
    }
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

interface TurnInput {
  endpoint: string;
  apiKey: string;
  model: string;
  isAnthropic: boolean;
  systemText: string;
  conv: InternalMessage[];
  tools?: AgentToolSpec[];
  signal?: AbortSignal;
  onText: (delta: string) => void;
  onUsage?: (usage: { input?: number; output?: number }) => void;
}

async function runOneTurn(t: TurnInput): Promise<TurnResult> {
  const { endpoint, apiKey, model, isAnthropic, systemText, conv, tools, signal, onText, onUsage } = t;

  const url = isAnthropic ? `${endpoint}/messages` : `${endpoint}/chat/completions`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };

  let body: string;
  if (isAnthropic) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
    body = JSON.stringify({
      model,
      max_tokens: 4096,
      stream: true,
      ...(systemText ? { system: systemText } : {}),
      ...(tools && tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
      messages: conv.map(toAnthropicMessage),
    });
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
    body = JSON.stringify({
      model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        ...(systemText ? [{ role: 'system', content: systemText }] : []),
        ...conv.flatMap(toOpenAIMessages),
      ],
      ...(tools && tools.length > 0
        ? {
            tools: tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
    });
  }

  const response = await fetch(url, { method: 'POST', headers, body, signal });
  if (!response.ok) {
    const raw = (await response.text().catch(() => '')).trim();
    const formatted = formatErrorBody(raw).slice(0, 500);
    throw new Error(`LLM ${response.status}: ${formatted || response.statusText}`);
  }
  if (!response.body) throw new Error('LLM response has no body to stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  let text = '';
  const toolUsesByIndex = new Map<number, ToolUse>();
  let stopReason = '';
  // Decode window: first delta to last delta. `firstDeltaAt` is set on the
  // first text/tool delta, then `lastDeltaAt` is bumped on every subsequent
  // delta so the diff captures pure inter-token streaming time.
  let firstDeltaAt: number | null = null;
  let lastDeltaAt = 0;
  let outputTokens = 0;
  const stampDelta = (): void => {
    const now = performance.now();
    if (firstDeltaAt === null) firstDeltaAt = now;
    lastDeltaAt = now;
  };

  const handleEvents = (events: StreamEvent[]): void => {
    for (const ev of events) {
      if (ev.type === 'text') {
        stampDelta();
        text += ev.delta;
        onText(ev.delta);
      } else if (ev.type === 'tool_start') {
        stampDelta();
        const existing = toolUsesByIndex.get(ev.index);
        if (existing) {
          if (ev.id) existing.id = ev.id;
          if (ev.name) existing.name = ev.name;
        } else {
          toolUsesByIndex.set(ev.index, { id: ev.id, name: ev.name, inputJson: '' });
        }
      } else if (ev.type === 'tool_delta') {
        stampDelta();
        const tu = toolUsesByIndex.get(ev.index);
        if (tu) tu.inputJson += ev.partialJson;
        else toolUsesByIndex.set(ev.index, { id: '', name: '', inputJson: ev.partialJson });
      } else if (ev.type === 'stop') {
        stopReason = ev.reason;
      } else if (ev.type === 'usage') {
        if (typeof ev.output === 'number' && ev.output >= 0) outputTokens = ev.output;
        onUsage?.({ input: ev.input, output: ev.output });
      }
    }
  };

  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIndex: number;
    while ((sepIndex = findFrameEnd(buffer)) !== -1) {
      const frame = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex).replace(/^(\r?\n){1,2}/, '');
      const events = parseFrame(frame, isAnthropic);
      if (events === null) break outer;
      handleEvents(events);
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const events = parseFrame(tail, isAnthropic);
    if (events !== null) handleEvents(events);
  }

  const toolUses = [...toolUsesByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => v)
    .filter((tu) => tu.name);

  const decodeMs = firstDeltaAt !== null ? Math.max(0, lastDeltaAt - firstDeltaAt) : 0;
  return { text, toolUses, stopReason, decodeMs, outputTokens };
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

function toAnthropicMessage(m: InternalMessage): AnthropicMessage {
  if (typeof m.content === 'string') {
    return { role: m.role, content: m.content };
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const b of m.content) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
    else if (b.type === 'tool_use')
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    else if (b.type === 'tool_result')
      blocks.push({ type: 'tool_result', tool_use_id: b.toolUseId, content: b.content });
  }
  return { role: m.role, content: blocks };
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

function toOpenAIMessages(m: InternalMessage): OpenAIMessage[] {
  if (typeof m.content === 'string') {
    return [{ role: m.role, content: m.content }];
  }
  if (m.role === 'assistant') {
    let text = '';
    const toolCalls: OpenAIToolCall[] = [];
    for (const b of m.content) {
      if (b.type === 'text') text += b.text;
      else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      }
    }
    const out: OpenAIMessage = { role: 'assistant', content: text || null };
    if (toolCalls.length > 0) out.tool_calls = toolCalls;
    return [out];
  }
  if (m.role === 'user') {
    const messages: OpenAIMessage[] = [];
    let text = '';
    for (const b of m.content) {
      if (b.type === 'text') text += b.text;
      else if (b.type === 'tool_result') {
        messages.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
      }
    }
    if (text) messages.unshift({ role: 'user', content: text });
    return messages;
  }
  return [{ role: m.role, content: '' }];
}

function parseFrame(frame: string, isAnthropic: boolean): StreamEvent[] | null {
  const dataLines: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return [];
  const payload = dataLines.join('\n');
  if (payload === '[DONE]') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }

  return isAnthropic ? parseAnthropicChunk(parsed) : parseOpenAIChunk(parsed);
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AnthropicChunk {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
}

function parseAnthropicChunk(parsed: unknown): StreamEvent[] {
  const obj = parsed as AnthropicChunk;
  const events: StreamEvent[] = [];
  if (obj.type === 'message_start') {
    const u = obj.message?.usage;
    if (u && (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number')) {
      events.push({ type: 'usage', input: u.input_tokens, output: u.output_tokens });
    }
  } else if (obj.type === 'content_block_start' && obj.content_block?.type === 'tool_use') {
    events.push({
      type: 'tool_start',
      index: obj.index ?? 0,
      id: obj.content_block.id ?? '',
      name: obj.content_block.name ?? '',
    });
  } else if (obj.type === 'content_block_delta') {
    const d = obj.delta;
    if (d?.type === 'text_delta' && typeof d.text === 'string') {
      events.push({ type: 'text', delta: d.text });
    } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
      events.push({ type: 'tool_delta', index: obj.index ?? 0, partialJson: d.partial_json });
    }
  } else if (obj.type === 'message_delta') {
    if (obj.delta?.stop_reason) {
      events.push({ type: 'stop', reason: obj.delta.stop_reason });
    }
    if (obj.usage && typeof obj.usage.output_tokens === 'number') {
      events.push({ type: 'usage', output: obj.usage.output_tokens });
    }
  }
  return events;
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
  choices?: {
    delta?: { content?: string; tool_calls?: OpenAIToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function parseOpenAIChunk(parsed: unknown): StreamEvent[] {
  const obj = parsed as OpenAIChunk;
  const events: StreamEvent[] = [];
  if (obj.usage && (typeof obj.usage.prompt_tokens === 'number' || typeof obj.usage.completion_tokens === 'number')) {
    events.push({
      type: 'usage',
      input: obj.usage.prompt_tokens,
      output: obj.usage.completion_tokens,
    });
  }
  const choice = obj.choices?.[0];
  if (!choice) return events;
  const delta = choice.delta;
  if (delta?.content) events.push({ type: 'text', delta: delta.content });
  if (Array.isArray(delta?.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (tc.id || tc.function?.name) {
        events.push({
          type: 'tool_start',
          index: idx,
          id: tc.id ?? '',
          name: tc.function?.name ?? '',
        });
      }
      const args = tc.function?.arguments;
      if (typeof args === 'string' && args.length > 0) {
        events.push({ type: 'tool_delta', index: idx, partialJson: args });
      }
    }
  }
  if (choice.finish_reason) {
    events.push({ type: 'stop', reason: choice.finish_reason });
  }
  return events;
}

export function safeParseJson(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

function requireString(value: string | null | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function findFrameEnd(buffer: string): number {
  const a = buffer.indexOf('\n\n');
  const b = buffer.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}
