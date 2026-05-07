import type { TourStage } from '../types';

const pickModel: TourStage = {
  id: 'pick-model',
  markdown:
    "Pick a local model from this dropdown. The local Gemma models run in your browser via WebGPU — there's no server in the loop. We'll use Gemma 4 E4B for this tour.",
  cutouts: ['chat.modelDropdown'],
  onEnter: [
    { action: 'toggleModelDropdown', params: { open: true } },
    { action: 'selectModel', params: { modelId: 'gemma-4-e4b' } },
  ],
  next: 'manual',
};

export default pickModel;
