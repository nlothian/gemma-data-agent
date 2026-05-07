import type { TourStage } from '../types';

const pythonOutput: TourStage = {
  id: 'python-output',
  markdown:
    "There's the plot — rendered in your browser. The **Plot** sub-tab shows the matplotlib figure; **Output** captures stdout, stderr, and the final expression.",
  cutouts: ['exec.pythonOutput'],
  next: 'manual',
};

export default pythonOutput;
