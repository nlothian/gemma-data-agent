import type { TourStage } from '../types';

const runButton: TourStage = {
  id: 'run-button',
  markdown:
    "Press **Play** next to Step to run the agent on your message. We'll press it for you.",
  cutouts: ['chat.playButton'],
  onEnter: [{ action: 'pressPlayButton', delayMs: 800 }],
  next: 'auto-after-actions',
};

export default runButton;
