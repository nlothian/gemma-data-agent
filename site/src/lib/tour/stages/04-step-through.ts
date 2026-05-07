import type { TourStage } from '../types';

const stepThrough: TourStage = {
  id: 'step-through',
  markdown:
    `Use **Step** to advance the agent one tool call at a time, or **Play** to let it run. 
    
The step button will explain each step to you as it goes. Try it yourself when the tour ends.`,
  cutouts: ['chat.stepButton', 'chat.playButton'],
  next: 'manual',
};

export default stepThrough;
