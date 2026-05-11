import type { TourStage } from '../types';

const features: TourStage = {
  id: 'features',
  markdown:
    'Toggle which agent features are enabled. The available features are: Data Loading, SQL, Python, React, Sub-agents.',
  cutouts: ['exec.featureSelector'],
  onEnter: [
    { action: 'toggleFeatureSelector', params: { open: true } },
    {
      action: 'setEnabledFeatures',
      params: {
        features: {
          dataLoading: true,
          runSql: false,
          runPython: true,
          runReact: true,
          runSubAgent: false,
          fileTools: true,
        },
      },
    },
  ],
  next: 'manual',
};

export default features;
