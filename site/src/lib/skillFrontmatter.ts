// Dependency-free parser for the small YAML-subset frontmatter block that
// gates on-demand `CallSkill` reference cards. Skill `.md` files carry a
// `---`-fenced header describing which feature unlocks the card and the prose
// used to advertise it; the body below the fence is the verbatim card the
// model sees (frontmatter stripped).
//
// This module is intentionally tiny and pure: `parseSkillMarkdown` is a
// referentially-transparent function of its string input. It throws
// `SkillFrontmatterError` on ANY malformed/missing/invalid input rather than
// degrading — `agentTools.ts` parses all skills eagerly at module load, so a
// bad frontmatter block fails app boot AND the whole test run loudly.

import type { AgentPromptFeatures } from './agentTools';

export type FeatureKey = keyof AgentPromptFeatures;

/**
 * Single runtime source of truth for the valid `requires-feature` values.
 * The compile-time guard below fails to typecheck if this drifts from
 * `keyof AgentPromptFeatures` in either direction.
 */
export const FEATURE_KEYS = [
  'dataLoading',
  'runSql',
  'runPython',
  'runReact',
  'runSubAgent',
  'fileTools',
] as const;

type _FeatureKeysCover = (typeof FEATURE_KEYS)[number] extends FeatureKey
  ? FeatureKey extends (typeof FEATURE_KEYS)[number]
    ? true
    : never
  : never;
// If this line errors, FEATURE_KEYS and AgentPromptFeatures have diverged.
const _featureKeysExhaustive: _FeatureKeysCover = true;
void _featureKeysExhaustive;

export interface SkillFrontmatter {
  /** CallSkill enum value + registry key, e.g. `python-pass-data`. */
  name: string;
  /** Feature flag that must be enabled for this card to be offered. */
  requiresFeature: FeatureKey;
  /** Whether the card is "REQUIRED before" vs merely "before" its tool. */
  required: boolean;
  /** Trigger phrase, authored to follow the literal word "before ". */
  when: string;
  /** Payload phrase, authored to follow the literal word "Returns ". */
  blurb: string;
}

export interface ParsedSkill {
  meta: SkillFrontmatter;
  /** Card body with the frontmatter block stripped + leading blanks trimmed. */
  body: string;
}

export class SkillFrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillFrontmatterError';
  }
}

const REQUIRED_KEYS = [
  'name',
  'requires-feature',
  'required',
  'when',
  'blurb',
] as const;
type FrontmatterKey = (typeof REQUIRED_KEYS)[number];
const ALLOWED_KEYS = new Set<string>(REQUIRED_KEYS);

const FENCE = '---';
const KEY_LINE = /^([a-z][a-z-]*):(.*)$/;

type RawValue = string | boolean;

function isFeatureKey(v: string): v is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(v);
}

/** Parse a double-quoted scalar. Supports only `\"` and `\\` escapes. */
function parseQuoted(v: string, key: string, label: string): string {
  let out = '';
  let i = 1; // skip opening quote
  while (i < v.length) {
    const c = v[i];
    if (c === '\\') {
      const n = v[i + 1];
      if (n === '"' || n === '\\') {
        out += n;
        i += 2;
        continue;
      }
      throw new SkillFrontmatterError(
        `${label}: unsupported escape "\\${n ?? ''}" in value for "${key}" ` +
          `(only \\" and \\\\ are supported).`,
      );
    }
    if (c === '"') {
      const rest = v.slice(i + 1).trim();
      if (rest !== '') {
        throw new SkillFrontmatterError(
          `${label}: unexpected content after closing quote for "${key}".`,
        );
      }
      return out;
    }
    out += c;
    i += 1;
  }
  throw new SkillFrontmatterError(
    `${label}: unterminated quoted string for "${key}".`,
  );
}

function parseValue(rawValue: string, key: string, label: string): RawValue {
  const v = rawValue.trim();
  if (v === '') {
    throw new SkillFrontmatterError(
      `${label}: empty value for "${key}".`,
    );
  }
  if (v[0] === '"') return parseQuoted(v, key, label);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v[0] === '[' || v[0] === '-' || v[0] === '{' || v[0] === '|' || v[0] === '>') {
    throw new SkillFrontmatterError(
      `${label}: unsupported value syntax for "${key}" — only quoted ` +
        `strings, bare scalars and true/false are allowed.`,
    );
  }
  return v;
}

/**
 * Parse a skill markdown string into `{ meta, body }`. Pure; throws
 * `SkillFrontmatterError` on any structural or value error. `label` is the
 * source identifier (e.g. file/skill name) embedded in error messages.
 */
export function parseSkillMarkdown(raw: string, label: string): ParsedSkill {
  // Strip a leading UTF-8 BOM, then normalise line endings so CRLF files
  // parse identically (the body is markdown for the model — LF is fine).
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);

  if ((lines[0] ?? '').trim() !== FENCE) {
    throw new SkillFrontmatterError(
      `${label}: missing frontmatter — file must start with a "---" line.`,
    );
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === FENCE) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    throw new SkillFrontmatterError(
      `${label}: unterminated frontmatter — no closing "---" line.`,
    );
  }

  const parsed: Partial<Record<FrontmatterKey, RawValue>> = {};
  for (let i = 1; i < closeIdx; i += 1) {
    const line = lines[i];
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue; // blank / comment
    const m = KEY_LINE.exec(t);
    if (!m) {
      throw new SkillFrontmatterError(
        `${label}: malformed frontmatter line ${i + 1}: ` +
          `${JSON.stringify(line)} — expected "key: value".`,
      );
    }
    const key = m[1];
    if (!ALLOWED_KEYS.has(key)) {
      throw new SkillFrontmatterError(
        `${label}: unknown frontmatter key ${JSON.stringify(key)}. ` +
          `Allowed: ${REQUIRED_KEYS.join(', ')}.`,
      );
    }
    if (key in parsed) {
      throw new SkillFrontmatterError(
        `${label}: duplicate frontmatter key ${JSON.stringify(key)}.`,
      );
    }
    parsed[key as FrontmatterKey] = parseValue(m[2], key, label);
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in parsed)) {
      throw new SkillFrontmatterError(
        `${label}: missing required frontmatter key ${JSON.stringify(key)}.`,
      );
    }
  }

  const name = parsed['name'];
  const requiresFeature = parsed['requires-feature'];
  const required = parsed['required'];
  const when = parsed['when'];
  const blurb = parsed['blurb'];

  if (typeof name !== 'string' || name === '') {
    throw new SkillFrontmatterError(
      `${label}: "name" must be a non-empty string.`,
    );
  }
  if (typeof requiresFeature !== 'string' || !isFeatureKey(requiresFeature)) {
    throw new SkillFrontmatterError(
      `${label}: "requires-feature" is ${JSON.stringify(requiresFeature)} — ` +
        `must be one of ${FEATURE_KEYS.join(', ')}.`,
    );
  }
  if (typeof required !== 'boolean') {
    throw new SkillFrontmatterError(
      `${label}: "required" must be true or false.`,
    );
  }
  if (typeof when !== 'string') {
    throw new SkillFrontmatterError(`${label}: "when" must be a string.`);
  }
  if (typeof blurb !== 'string') {
    throw new SkillFrontmatterError(`${label}: "blurb" must be a string.`);
  }

  // Body = everything after the closing fence, with leading blank lines
  // trimmed so `# Title` is line 1 (matching the pre-frontmatter cards) and
  // trailing whitespace removed. Any later "---" (hr / code fence) is left
  // untouched — only the first fenced block at the top is frontmatter.
  const body = lines
    .slice(closeIdx + 1)
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/\s+$/, '');

  return {
    meta: { name, requiresFeature, required, when, blurb },
    body,
  };
}
