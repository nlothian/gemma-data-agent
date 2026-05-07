import type { TourStage } from '../types';

const sourcecodeView: TourStage = {
  id: 'sourcecode-view',
  markdown:
    "Click any `@sourcecode:` citation in the Explainer's reply to jump straight to the code. We'll click the first one for you — the **Sourcecode** panel slides in showing the exact lines the Explainer cited.",
  cutouts: ['exec.explainerMessages', 'sourcecode.viewer'],
  onEnter: [
    { action: 'clickFirstSourcecodeLink', delayMs: 400 },
  ],
  onExit: [
    { action: 'closeSourcecode' },
    { action: 'pressAgentsExpand', delayMs: 200 },
  ],
  next: 'manual',
};

export default sourcecodeView;
