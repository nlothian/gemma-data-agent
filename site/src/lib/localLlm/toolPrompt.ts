/**
 * Prompt + parser glue for Gemma 4's native chat template.
 *
 * Mirrors `chat_template.jinja` from google/gemma-4-* (the litert-lm task
 * files are distilled from these checkpoints, so the surface tokens are the
 * same). MediaPipe's LlmInference does not apply a chat template, so we have
 * to emit the exact token sequence the model was trained on.
 *
 * Tokens (each is one tokenizer entry):
 *   <|turn>{role}\n ... <turn|>\n         turn delimiters
 *   <|tool>declaration:name{...}<tool|>   tool declaration (system block)
 *   <|tool_call>call:name{...}<tool_call|>      model emits to call a tool
 *   <|tool_response>response:name{...}<tool_response|>  we inject the result
 *   <|"|>...<|"|>                         string literal delimiters
 *   <|channel>thought\n...<channel|>      reasoning channel
 *
 * Tool call/response bodies use a JSON-like format with bare keys and the
 * `<|"|>` string delimiter, e.g. `{location:<|"|>Paris<|"|>,units:<|"|>c<|"|>}`.
 */

import type { AgentToolSpec } from '../agentTools';
import { safeParseJson } from '../streamChat';

export const TURN_OPEN = '<|turn>';
export const TURN_CLOSE = '<turn|>';
export const TOOL_DECL_OPEN = '<|tool>';
export const TOOL_DECL_CLOSE = '<tool|>';
export const TOOL_CALL_OPEN = '<|tool_call>';
export const TOOL_CALL_CLOSE = '<tool_call|>';
export const TOOL_RESPONSE_OPEN = '<|tool_response>';
export const TOOL_RESPONSE_CLOSE = '<tool_response|>';
export const STRING_DELIM = '<|"|>';
export const CHANNEL_OPEN = '<|channel>';
export const CHANNEL_CLOSE = '<channel|>';
export const EMPTY_THOUGHT = `${CHANNEL_OPEN}thought\n${CHANNEL_CLOSE}`;

export interface InternalMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
}

// ---- formatting argument values to the Gemma 4 wire format -----------------

function formatString(s: string): string {
  return `${STRING_DELIM}${s}${STRING_DELIM}`;
}

/**
 * Format a value the way the template's `format_argument` macro does. Object
 * keys are emitted bare (matches `escape_keys=False`, used for tool_call and
 * tool_response bodies).
 */
function formatArgValue(value: unknown): string {
  if (value === null || value === undefined) return formatString('');
  if (typeof value === 'string') return formatString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(formatArgValue).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${k}:${formatArgValue(v)}`).join(',')}}`;
  }
  return formatString(String(value));
}

function formatArgBody(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}:${formatArgValue(v)}`)
    .join(',');
}

/** Render a JSON-encoded value as a Gemma-wire-format body. Top-level objects
 * become bare `key:value,...` pairs; anything else becomes `value:...`. */
function bodyFromJson(json: string): string {
  const parsed = safeParseJson(json);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return formatArgBody(parsed as Record<string, unknown>);
  }
  return `value:${formatArgValue(parsed)}`;
}

export function formatToolCallToken(name: string, argsJson: string): string {
  return `${TOOL_CALL_OPEN}call:${name}{${bodyFromJson(argsJson)}}${TOOL_CALL_CLOSE}`;
}

export function formatToolResponseToken(name: string, resultJson: string): string {
  return `${TOOL_RESPONSE_OPEN}response:${name}{${bodyFromJson(resultJson)}}${TOOL_RESPONSE_CLOSE}`;
}

// ---- tool declaration block (system turn) ---------------------------------

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  nullable?: boolean;
}

function formatParamProperty(schema: JsonSchema): string {
  const parts: string[] = [];
  if (schema.description) parts.push(`description:${formatString(schema.description)}`);
  const type = (schema.type ?? '').toUpperCase();
  if (type === 'STRING' && schema.enum) {
    parts.push(`enum:[${schema.enum.map(formatArgValue).join(',')}]`);
  } else if (type === 'ARRAY' && schema.items && typeof schema.items === 'object') {
    const items = schema.items;
    const itemParts: string[] = [];
    if (items.properties) {
      itemParts.push(`properties:{${formatProperties(items.properties)}}`);
    }
    if (items.required && items.required.length > 0) {
      itemParts.push(`required:[${items.required.map(formatString).join(',')}]`);
    }
    if (items.type) {
      itemParts.push(`type:${formatString(items.type.toUpperCase())}`);
    }
    parts.push(`items:{${itemParts.join(',')}}`);
  }
  if (schema.nullable) parts.push('nullable:true');
  if (type === 'OBJECT' && schema.properties) {
    parts.push(`properties:{${formatProperties(schema.properties)}}`);
    if (schema.required && schema.required.length > 0) {
      parts.push(`required:[${schema.required.map(formatString).join(',')}]`);
    }
  }
  parts.push(`type:${formatString(type)}`);
  return parts.join(',');
}

function formatProperties(props: Record<string, JsonSchema>): string {
  // Sorted to match jinja's `dictsort`.
  return Object.keys(props)
    .sort()
    .map((k) => `${k}:{${formatParamProperty(props[k])}}`)
    .join(',');
}

function formatToolDeclaration(spec: AgentToolSpec): string {
  let body = `description:${formatString(spec.description)}`;
  const params = spec.parameters as JsonSchema | undefined;
  if (params && Object.keys(params).length > 0) {
    const inner: string[] = [];
    if (params.properties) {
      inner.push(`properties:{${formatProperties(params.properties)}}`);
    }
    if (params.required && params.required.length > 0) {
      inner.push(`required:[${params.required.map(formatString).join(',')}]`);
    }
    if (params.type) {
      inner.push(`type:${formatString(params.type.toUpperCase())}`);
    }
    body += `,parameters:{${inner.join(',')}}`;
  }
  return `declaration:${spec.name}{${body}}`;
}

// ---- prompt rendering -----------------------------------------------------

export function renderConversationForGemma(
  systemPrompt: string,
  messages: InternalMessage[],
  tools: AgentToolSpec[] = [],
  thinkingEnabled: boolean = false,
): string {
  let out = '';

  if (systemPrompt || tools.length > 0) {
    out += `${TURN_OPEN}system\n`;
    if (systemPrompt) out += systemPrompt;
    for (const tool of tools) {
      out += `${TOOL_DECL_OPEN}${formatToolDeclaration(tool)}${TOOL_DECL_CLOSE}`;
    }
    out += `${TURN_CLOSE}\n`;
  }

  // Past model turns get a bare <|turn>model\n (no thought channel — the
  // empty-thought marker is for the *generation* prompt only). Tool
  // responses stay inside the open model turn.
  let modelTurnOpen = false;
  let lastWasToolResponse = false;

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (modelTurnOpen) {
        out += `${TURN_CLOSE}\n`;
        modelTurnOpen = false;
      }
      out += `${TURN_OPEN}user\n${msg.content}${TURN_CLOSE}\n`;
      lastWasToolResponse = false;
    } else if (msg.role === 'assistant') {
      if (!modelTurnOpen) {
        out += `${TURN_OPEN}model\n`;
        modelTurnOpen = true;
      }
      out += msg.content;
      lastWasToolResponse = false;
    } else {
      if (!modelTurnOpen) {
        out += `${TURN_OPEN}model\n`;
        modelTurnOpen = true;
      }
      const name = msg.toolName ?? 'unknown';
      out += `${TOOL_RESPONSE_OPEN}response:${name}{${bodyFromJson(msg.content)}}${TOOL_RESPONSE_CLOSE}`;
      lastWasToolResponse = true;
    }
  }

  // Generation prompt. If the last message was a tool response, the model
  // continues the same turn with no new <|turn>model\n and no thought-channel
  // marker (the `thinkingEnabled` flag does not affect this case). Otherwise
  // open a fresh model turn: when `thinkingEnabled` is false (default) emit
  // the empty-thought marker (forces non-thinking mode, matching the template's
  // add_generation_prompt path with enable_thinking=false); when true, leave
  // the thought channel open so the model fills it with reasoning and emits
  // its own `<channel|>` to close.
  if (!lastWasToolResponse) {
    if (modelTurnOpen) out += `${TURN_CLOSE}\n`;
    if (thinkingEnabled) {
      out += `${TURN_OPEN}model\n${CHANNEL_OPEN}thought\n`;
    } else {
      out += `${TURN_OPEN}model\n${EMPTY_THOUGHT}`;
    }
  }

  return out;
}

// ---- streaming parser for tool calls --------------------------------------

export interface ToolCallChunk {
  name: string;
  argsJson: string;
}

export interface IncrementalParseResult {
  emitText: string;
  toolCall: ToolCallChunk | null;
  rest: string;
}

/**
 * Stateless incremental parser. Scans the buffer for a complete
 * `<|tool_call>call:NAME{...}<tool_call|>` block. Anything before a possible
 * opening tag is safe to forward to the UI; anything from the opening tag
 * onward is held until the closing tag arrives.
 */
export function parseStreamForToolCall(buffer: string): IncrementalParseResult {
  const openIdx = buffer.indexOf(TOOL_CALL_OPEN);
  if (openIdx === -1) {
    // Hold back enough trailing chars to detect a partial opening tag.
    const safeEmitLen = Math.max(0, buffer.length - (TOOL_CALL_OPEN.length - 1));
    return {
      emitText: buffer.slice(0, safeEmitLen),
      toolCall: null,
      rest: buffer.slice(safeEmitLen),
    };
  }
  const before = buffer.slice(0, openIdx);
  const after = buffer.slice(openIdx + TOOL_CALL_OPEN.length);
  const closeIdx = after.indexOf(TOOL_CALL_CLOSE);
  if (closeIdx === -1) {
    return { emitText: before, toolCall: null, rest: buffer.slice(openIdx) };
  }
  const inner = after.slice(0, closeIdx);
  const rest = after.slice(closeIdx + TOOL_CALL_CLOSE.length);

  const parsed = parseToolCallBody(inner);
  if (!parsed) {
    return {
      emitText: before + TOOL_CALL_OPEN + inner + TOOL_CALL_CLOSE,
      toolCall: null,
      rest,
    };
  }
  return { emitText: before, toolCall: parsed, rest };
}

/**
 * Parse a `call:NAME{key:value,...}` body into a function name + JSON args.
 * Values may be:
 *   - <|"|>...<|"|>  string literal
 *   - true / false   boolean
 *   - 123 / -1.5     number
 *   - {k:v,...}      nested object (bare keys)
 *   - [v,v,...]      array
 */
function parseToolCallBody(raw: string): ToolCallChunk | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('call:')) return null;
  const rest = trimmed.slice('call:'.length);
  const braceIdx = rest.indexOf('{');
  if (braceIdx === -1) return null;
  const name = rest.slice(0, braceIdx).trim();
  if (!name) return null;
  const body = rest.slice(braceIdx);
  if (!body.endsWith('}')) return null;
  try {
    const p = new BodyParser(body);
    const obj = p.parseObject();
    p.skipWs();
    if (!p.eof()) return null;
    return { name, argsJson: JSON.stringify(obj) };
  } catch {
    return null;
  }
}

class BodyParser {
  private i = 0;
  constructor(private readonly src: string) {}

  eof(): boolean {
    return this.i >= this.src.length;
  }

  skipWs(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
  }

  peek(): string {
    return this.src[this.i] ?? '';
  }

  consume(s: string): void {
    if (this.src.slice(this.i, this.i + s.length) !== s) {
      throw new Error(`expected ${s} at ${this.i}`);
    }
    this.i += s.length;
  }

  parseValue(): unknown {
    this.skipWs();
    if (this.src.startsWith(STRING_DELIM, this.i)) return this.parseString();
    const c = this.peek();
    if (c === '{') return this.parseObject();
    if (c === '[') return this.parseArray();
    if (c === 't' || c === 'f') return this.parseBool();
    if (c === 'n' && this.src.startsWith('null', this.i)) {
      this.i += 4;
      return null;
    }
    if (c === '-' || (c >= '0' && c <= '9')) return this.parseNumber();
    // Fallback: read until next structural char as a bare token (treat as string).
    const start = this.i;
    while (
      this.i < this.src.length &&
      !',}]'.includes(this.src[this.i]) &&
      !this.src.startsWith(STRING_DELIM, this.i)
    ) {
      this.i++;
    }
    return this.src.slice(start, this.i).trim();
  }

  parseString(): string {
    this.consume(STRING_DELIM);
    const end = this.src.indexOf(STRING_DELIM, this.i);
    if (end === -1) throw new Error('unterminated string');
    const v = this.src.slice(this.i, end);
    this.i = end + STRING_DELIM.length;
    return v;
  }

  parseObject(): Record<string, unknown> {
    this.consume('{');
    const out: Record<string, unknown> = {};
    this.skipWs();
    if (this.peek() === '}') {
      this.i++;
      return out;
    }
    while (!this.eof()) {
      this.skipWs();
      const keyStart = this.i;
      while (this.i < this.src.length && this.src[this.i] !== ':' && !/\s/.test(this.src[this.i])) {
        this.i++;
      }
      const key = this.src.slice(keyStart, this.i).trim();
      this.skipWs();
      this.consume(':');
      const val = this.parseValue();
      out[key] = val;
      this.skipWs();
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      if (this.peek() === '}') {
        this.i++;
        return out;
      }
      throw new Error(`expected , or } at ${this.i}`);
    }
    throw new Error('unterminated object');
  }

  parseArray(): unknown[] {
    this.consume('[');
    const out: unknown[] = [];
    this.skipWs();
    if (this.peek() === ']') {
      this.i++;
      return out;
    }
    while (!this.eof()) {
      out.push(this.parseValue());
      this.skipWs();
      if (this.peek() === ',') {
        this.i++;
        continue;
      }
      if (this.peek() === ']') {
        this.i++;
        return out;
      }
      throw new Error(`expected , or ] at ${this.i}`);
    }
    throw new Error('unterminated array');
  }

  parseBool(): boolean {
    if (this.src.startsWith('true', this.i)) {
      this.i += 4;
      return true;
    }
    if (this.src.startsWith('false', this.i)) {
      this.i += 5;
      return false;
    }
    throw new Error(`expected bool at ${this.i}`);
  }

  parseNumber(): number {
    const start = this.i;
    if (this.peek() === '-') this.i++;
    while (this.i < this.src.length && /[0-9.eE+-]/.test(this.src[this.i])) this.i++;
    const n = Number(this.src.slice(start, this.i));
    if (Number.isNaN(n)) throw new Error(`bad number at ${start}`);
    return n;
  }
}
