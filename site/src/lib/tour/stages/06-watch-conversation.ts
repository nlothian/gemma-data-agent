import type { TourStage } from '../types';

const watchConversation: TourStage = {
  id: 'watch-conversation',
  markdown:
    `Watch the conversation as the agent thinks and calls its first tool. Note that you can inspect the system prompt in the drop-down at the top.
    
We'll wait here while it streams — click **Next** when you're ready to move on.`,
  cutouts: ['chat.conversation', 'chat.throbber'],
  onEnter: [{ action: 'waitForLlmIdle', params: { timeoutMs: 60000 } }],
  next: 'manual',
};

export default watchConversation;
