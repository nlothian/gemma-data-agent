import type { TourDefinition } from '../types';
import welcome from './01-welcome';
import pickModel from './02-pick-model';
import typeMessage from './03-type-message';
import stepThrough from './04-step-through';
import runButton from './05-run-button';
import watchConversation from './06-watch-conversation';
import features from './07-features';
import pythonPlot from './08-python-plot';
import pythonOutput from './09-python-output';
import subAgentsPipeline from './10-subagents-pipeline';

export const DEFAULT_TOUR: TourDefinition = {
  id: 'default',
  stages: [
    welcome,
    pickModel,
    typeMessage,
    stepThrough,
    runButton,
    watchConversation,
    features,
    pythonPlot,
    pythonOutput,
    subAgentsPipeline,
  ],
};
