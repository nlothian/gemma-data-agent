import type { TourStage } from '../types';

const TRAIN_CSV_URL =
  'https://gist.githubusercontent.com/nlothian/65faed428e86c9724e83c4426d86c783/raw/7ecb4390910ee3400cc49dea0f8d1775fa53172b/train.csv';

const PROMPT = `Run two separate sub-agents, one after the other, using the RunSubAgent tool:

1. First sub-agent: load the CSV at ${TRAIN_CSV_URL} as a table named \`train\` (use the LoadData tool).
2. Second sub-agent: train a linear regression in Python (RunPython) on the \`train\` table, predicting Survived from the \`Sex\` feature only. Print the fitted coefficients and R² score.

Each sub-task must run in its own RunSubAgent call.`;

const subAgentsPipeline: TourStage = {
  id: 'subagents-pipeline',
  markdown:
    "Now we'll run a two-stage pipeline through **sub-agents**: one loads a CSV, the other trains a linear regression on the `Sex` feature. Watch the SubAgents tab — each task runs in its own isolated LLM context, and only the final text returns to the main thread.",
  cutouts: ['chat.conversation', 'chat.throbber', 'exec.panel'],
  onEnter: [
    { action: 'newChat' },
    {
      action: 'setEnabledFeatures',
      params: {
        features: {
          dataLoading: true,
          runSql: false,
          runPython: true,
          runReact: false,
          runSubAgent: true,
        },
      },
    },
    { action: 'typeMessage', params: { text: PROMPT }, delayMs: 200 },
    { action: 'pressPlayButton', delayMs: 600 },
    { action: 'waitForLlmIdle', params: { timeoutMs: 600000 } },
  ],
  next: 'manual',
};

export { TRAIN_CSV_URL, PROMPT };
export default subAgentsPipeline;
