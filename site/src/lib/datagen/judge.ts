/**
 * Judge: grades a student's final answer against a gold reference using
 * the teacher (a frontier model via OpenRouter). Cheap-but-not-free —
 * one extra teacher call per scored rollout.
 */
import { type LLMConfig } from '../../types/llm';
import judgeSystemPrompt from './prompts/judge.md?raw';
import { callTeacher } from './teacher';

export interface JudgeVerdict {
  correct: boolean;
  reasoning: string;
}

export class JudgeProtocolError extends Error {}

const JSON_FENCE_RE = /```(?:json)?\s*\n?([\s\S]*?)\n?```/;

function extractJsonBody(raw: string): string {
  const fenced = JSON_FENCE_RE.exec(raw);
  if (fenced) return fenced[1].trim();
  // Some models emit bare JSON without the fence; accept that too.
  return raw.trim();
}

export async function judgeAnswer(args: {
  mainConfig: LLMConfig;
  judgeModel: string;
  userQuestion: string;
  referenceAnswer: string;
  candidateAnswer: string;
}): Promise<JudgeVerdict> {
  const userPayload = [
    `# User question`,
    args.userQuestion,
    ``,
    `# Reference (gold) answer`,
    args.referenceAnswer,
    ``,
    `# Candidate (student) answer`,
    args.candidateAnswer,
  ].join('\n');

  const raw = await callTeacher(
    args.mainConfig,
    args.judgeModel,
    judgeSystemPrompt,
    userPayload,
  );

  const body = extractJsonBody(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    throw new JudgeProtocolError(
      `Judge JSON did not parse: ${(err as Error).message} — raw: ${raw.slice(0, 200)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new JudgeProtocolError('Judge response was not an object.');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.correct !== 'boolean') {
    throw new JudgeProtocolError('Judge response missing boolean "correct".');
  }
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
  return { correct: obj.correct, reasoning };
}
