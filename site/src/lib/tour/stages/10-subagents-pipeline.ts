import { TOUR_DATA_ORIGIN_TOKEN } from '../actions';
import type { TourStage } from '../types';

// Served from site/public/tour-data/. The token is substituted at dispatch
// time — see TOUR_DATA_ORIGIN_TOKEN in ../actions for why it is a placeholder.
const TRAIN_CSV_URL_TEMPLATE = `${TOUR_DATA_ORIGIN_TOKEN}/tour-data/train.csv`;

const PROMPT = `Run two separate sub-agents, one after the other, using the RunSubAgent tool:

1. First sub-agent: load the CSV at ${TRAIN_CSV_URL_TEMPLATE} as a table named \`train\` (use the LoadData tool).
2. Second sub-agent: train a linear regression in Python (RunPython) on the \`train\` table, predicting Survived from the \`Sex\` feature only. Print the fitted coefficients and R² score.

Each sub-task must run in its own RunSubAgent call. You do not need to call skills or run python yourself - rely on the sub-agents for this.

Print out the results returned from the second sub-agent.
`;

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
          fileTools: true,
        },
      },
    },
    { action: 'typeMessage', params: { text: PROMPT }, delayMs: 200 },
    { action: 'pressPlayButton', delayMs: 600 },
    { action: 'waitForLlmIdle', params: { timeoutMs: 600000 } },
  ],
  next: 'manual',
};

export { TRAIN_CSV_URL_TEMPLATE, PROMPT };
export default subAgentsPipeline;
