/**
 * Teacher = a frontier model accessed via OpenRouter, used to generate
 * high-quality reference trajectories for fine-tuning.
 *
 * Reuses the existing `callLLM` from `lib/llm.ts`. Because the user's main
 * chat config (`activeEndpoint`, etc.) may point at any provider — including
 * the local Gemma — we build a *synthetic* `LLMConfig` for each teacher call
 * that pins the endpoint to OpenRouter and the model to whatever the
 * data-gen UI selected. The OpenRouter API key is read from the user's
 * existing `apiKeys` storage, which they will have populated via the
 * normal Settings UI.
 */

import { callLLM } from '../llm';
import { type LLMConfig } from '../../types/llm';

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';

export class TeacherConfigError extends Error {}

/**
 * Build a one-shot LLMConfig pinned to OpenRouter + the chosen teacher
 * model, derived from the user's existing main config (so we read their
 * stored API key).
 */
export function buildTeacherConfig(
  mainConfig: LLMConfig,
  teacherModel: string,
): LLMConfig {
  if (!mainConfig.apiKeys[OPENROUTER_ENDPOINT]?.trim()) {
    throw new TeacherConfigError(
      'No OpenRouter API key found. Add one in the main Settings UI before running data generation.',
    );
  }
  if (!teacherModel) {
    throw new TeacherConfigError('No teacher model selected.');
  }
  return {
    ...mainConfig,
    activeEndpoint: OPENROUTER_ENDPOINT,
    models: { ...mainConfig.models, [OPENROUTER_ENDPOINT]: teacherModel },
  };
}

export async function callTeacher(
  mainConfig: LLMConfig,
  teacherModel: string,
  system: string,
  user: string,
): Promise<string> {
  const cfg = buildTeacherConfig(mainConfig, teacherModel);
  return callLLM(cfg, system, user);
}
