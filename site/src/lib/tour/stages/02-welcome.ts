import type { TourStage } from '../types';

const welcome: TourStage = {
  id: 'welcome',
  markdown:
    'Welcome — this short tour will walk you through the chat sidebar, model picker, the agent\'s step-by-step execution gate, and the feature toggles. We\'ll start from a fresh chat.',
  cutouts: ['chat.messageEntry'],
  onEnter: [{ action: 'newChat' }],
  next: 'manual',
};

export default welcome;
