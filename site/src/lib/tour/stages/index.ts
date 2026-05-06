import type { TourDefinition } from '../types';
import pickModel from './01-pick-model';
import welcome from './02-welcome';
import typeMessage from './03-type-message';
import stepThrough from './04-step-through';
import runButton from './05-run-button';
import watchConversation from './05b-watch-conversation';
import features from './06-features';
import pythonPlot from './07-python-plot';
import pythonOutput from './08-python-output';

export const DEFAULT_TOUR: TourDefinition = {
  id: 'default',
  stages: [
    pickModel,
    welcome,
    typeMessage,
    stepThrough,
    runButton,
    watchConversation,
    features,
    pythonPlot,
    pythonOutput,
  ],
};
