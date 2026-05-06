import type { TourStage } from '../types';

const pickModel: TourStage = {
  id: 'pick-model',
  markdown:
    "Pick a local model from this dropdown. The local Gemma models run in your browser via WebGPU — there's no server in the loop.",
  cutouts: ['chat.modelDropdown'],
  onEnter: [{ action: 'toggleModelDropdown', params: { open: true } }],
  next: 'manual',
};

export default pickModel;
