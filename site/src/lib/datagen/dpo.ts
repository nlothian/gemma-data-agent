/**
 * DPO pair generation from a set of student rollouts on the same task.
 *
 * Strategy (per user direction): de-duplicate trajectories by exact
 * `historyText` match, then take the cross-product of distinct successes
 * × distinct failures. This avoids redundancy from rollouts that happened
 * to produce identical traces while preserving the "many slightly-different
 * negatives" signal that small models learn well from.
 */

export type FailureReason =
  | 'hard_error'
  | 'parse_error'
  | 'tool_error'
  | 'max_iterations'
  | 'judge_incorrect';

export interface ScoredRollout {
  rolloutIndex: number;
  historyText: string;
  displayText: string;
  finalAnswer: string;
  outcome: 'success' | FailureReason;
  judgeReasoning?: string;
}

export interface DpoPair {
  schema: 'haw-dpo-v1';
  runId: string;
  taskId: string;
  userPrompt: string;
  systemPrompt: string;
  chosen: string;
  rejected: string;
  chosenDisplayText: string;
  rejectedDisplayText: string;
  chosenFinalAnswer: string;
  rejectedFinalAnswer: string;
  chosenJudgeReasoning?: string;
  rejectedFailureReason: FailureReason;
  studentModel: string;
  judgeModel: string | null;
  createdAt: string;
}

export interface BuildDpoPairsArgs {
  runId: string;
  taskId: string;
  userPrompt: string;
  systemPrompt: string;
  rollouts: ScoredRollout[];
  studentModel: string;
  judgeModel: string | null;
}

export function buildDpoPairs(args: BuildDpoPairsArgs): DpoPair[] {
  const successes = new Map<string, ScoredRollout>();
  const failures = new Map<string, ScoredRollout>();

  for (const r of args.rollouts) {
    if (r.outcome === 'success') {
      if (!successes.has(r.historyText)) successes.set(r.historyText, r);
    } else {
      if (!failures.has(r.historyText)) failures.set(r.historyText, r);
    }
  }

  if (successes.size === 0 || failures.size === 0) return [];

  const createdAt = new Date().toISOString();
  const pairs: DpoPair[] = [];
  for (const chosen of successes.values()) {
    for (const rejected of failures.values()) {
      pairs.push({
        schema: 'haw-dpo-v1',
        runId: args.runId,
        taskId: args.taskId,
        userPrompt: args.userPrompt,
        systemPrompt: args.systemPrompt,
        chosen: chosen.historyText,
        rejected: rejected.historyText,
        chosenDisplayText: chosen.displayText,
        rejectedDisplayText: rejected.displayText,
        chosenFinalAnswer: chosen.finalAnswer,
        rejectedFinalAnswer: rejected.finalAnswer,
        chosenJudgeReasoning: chosen.judgeReasoning,
        rejectedFailureReason: rejected.outcome as FailureReason,
        studentModel: args.studentModel,
        judgeModel: args.judgeModel,
        createdAt,
      });
    }
  }
  return pairs;
}
