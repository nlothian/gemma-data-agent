import { describe, it, expect } from 'vitest';
import subAgentsPipeline, {
  PROMPT,
  TRAIN_CSV_URL,
} from '../stages/10-subagents-pipeline';
import { DEFAULT_TOUR } from '../stages';
import { ACTION_NAMES } from '../actions';

describe('subagents-pipeline stage', () => {
  it('is registered as the last stage in DEFAULT_TOUR', () => {
    const last = DEFAULT_TOUR.stages[DEFAULT_TOUR.stages.length - 1];
    expect(last).toBe(subAgentsPipeline);
    expect(last.id).toBe('subagents-pipeline');
  });

  it('uses only known action names', () => {
    const valid = new Set<string>(ACTION_NAMES);
    for (const step of subAgentsPipeline.onEnter ?? []) {
      expect(valid.has(step.action)).toBe(true);
    }
  });

  it('spotlights both the conversation and the execution panel', () => {
    expect(subAgentsPipeline.cutouts).toEqual(
      expect.arrayContaining(['chat.conversation', 'exec.panel']),
    );
  });

  it('starts from a fresh chat by clearing first', () => {
    const first = (subAgentsPipeline.onEnter ?? [])[0];
    expect(first?.action).toBe('newChat');
  });

  it('enables dataLoading, runPython, and runSubAgent before sending', () => {
    const step = (subAgentsPipeline.onEnter ?? []).find(
      (s) => s.action === 'setEnabledFeatures',
    );
    expect(step).toBeDefined();
    const features = (step!.params as { features: Record<string, boolean> }).features;
    expect(features.dataLoading).toBe(true);
    expect(features.runPython).toBe(true);
    expect(features.runSubAgent).toBe(true);
  });

  it('types the multi-step prompt and then presses play', () => {
    const steps = subAgentsPipeline.onEnter ?? [];
    const typeIdx = steps.findIndex((s) => s.action === 'typeMessage');
    const playIdx = steps.findIndex((s) => s.action === 'pressPlayButton');
    expect(typeIdx).toBeGreaterThan(-1);
    expect(playIdx).toBeGreaterThan(typeIdx);
    const typed = (steps[typeIdx].params as { text: string }).text;
    expect(typed).toBe(PROMPT);
  });

  it('prompt mentions sub-agents, the CSV URL, and the Sex feature', () => {
    expect(PROMPT).toContain('RunSubAgent');
    expect(PROMPT).toContain(TRAIN_CSV_URL);
    expect(PROMPT).toContain('Sex');
    expect(PROMPT).toMatch(/linear regression/i);
  });

  it('uses a generous wait timeout for the long LLM run', () => {
    const wait = (subAgentsPipeline.onEnter ?? []).find(
      (s) => s.action === 'waitForLlmIdle',
    );
    expect(wait).toBeDefined();
    const t = (wait!.params as { timeoutMs?: number }).timeoutMs;
    expect(typeof t).toBe('number');
    expect(t).toBeGreaterThanOrEqual(120000);
  });

  it('waits for the user to advance after the LLM finishes', () => {
    expect(subAgentsPipeline.next).toBe('manual');
  });
});
