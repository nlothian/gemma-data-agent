import type { TourStage } from '../types';

const typeMessage: TourStage = {
  id: 'type-message',
  markdown: "Type a chat message here. We'll fill it in for you.",
  cutouts: ['chat.messageEntry'],
  onEnter: [
    { action: 'toggleModelDropdown', params: { open: false } },
    { action: 'typeMessage', params: { text: 'hi' }, delayMs: 200 },
  ],
  next: 'manual',
};

export default typeMessage;
