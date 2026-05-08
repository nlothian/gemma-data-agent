import type { TourStage } from '../types';

const sourcecodeView: TourStage = {
  id: 'sourcecode-view',
  markdown:
    "Click any `@sourcecode:` citation in the Explainer's reply to jump straight to the code. We'll click the first one for you — the **Sourcecode** panel slides in showing the exact lines the Explainer cited.",
  cutouts: ['exec.explainerMessages', 'sourcecode.viewer'],
  // The Sourcecode drawer covers the right half of the viewport. Anchor the
  // card above the explainer cutout so the drawer doesn't paint over it.
  placement: 'above',
  placementAnchor: 'exec.explainerMessages',
  onEnter: [
    { action: 'clickFirstSourcecodeLink', delayMs: 400 },
  ],
  // Last stage: End Tour calls next() → end(), which restores both panes
  // to expanded. We deliberately don't run pressAgentsExpand here — it
  // would collapse the Explainer for one frame before end() re-expanded it.
  onExit: [
    { action: 'closeSourcecode' },
  ],
  next: 'manual',
};

export default sourcecodeView;
