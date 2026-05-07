import type { TourStage } from '../types';

const PROMPT = 'Show me how the LoadData function runs';

const explainerSourcecode: TourStage = {
  id: 'explainer-sourcecode',
  markdown:
    "Now we'll use the **Explainer** to navigate the codebase. We'll maximize the Explainer pane and ask it about the LoadData function. The Explainer has its own LLM conversation with read-only `GrepCodebase` / `ReadLines` / `HighlightSourcecode` tools — answers cite real lines via `@sourcecode:` links.",
  cutouts: ['exec.explainerPanel'],
  onEnter: [
    { action: 'pressExplainerExpand' },
    { action: 'typeExplainerMessage', params: { text: PROMPT }, delayMs: 300 },
    { action: 'sendExplainerMessage', delayMs: 400 },
    { action: 'waitForExplainerIdle', params: { timeoutMs: 600000 } },
  ],
  next: 'auto-after-actions',
};

export { PROMPT };
export default explainerSourcecode;
