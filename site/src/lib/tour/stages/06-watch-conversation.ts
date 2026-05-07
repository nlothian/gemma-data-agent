import type { TourStage } from '../types';

const watchConversation: TourStage = {
  id: 'watch-conversation',
  markdown:
    "Watch the conversation as the agent thinks and calls its first tool. We'll wait here while it streams — click **Next** when you're ready to move on.",
  cutouts: ['chat.conversation'],
  onEnter: [{ action: 'waitForLlmIdle', params: { timeoutMs: 60000 } }],
  next: 'manual',
};

export default watchConversation;
