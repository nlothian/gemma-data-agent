import type { TourStage } from '../types';

const stepThrough: TourStage = {
  id: 'step-through',
  markdown:
    'Use **Step** to advance the agent one tool call at a time, or **Play** to let it run. The tour does not press these for you — try it yourself when the tour ends.',
  cutouts: ['chat.stepButton', 'chat.playButton'],
  next: 'manual',
};

export default stepThrough;
