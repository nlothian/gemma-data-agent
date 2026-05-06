import type { CutoutId } from './cutouts';
import type { ActionName, ActionParams } from './actions';

export interface TourActionStep<N extends ActionName = ActionName> {
  action: N;
  params?: ActionParams[N];
  delayMs?: number;
}

export interface TourStage {
  id: string;
  markdown: string;
  cutouts: CutoutId[];
  onEnter?: TourActionStep[];
  next?: 'manual' | 'auto-after-actions';
}

export interface TourDefinition {
  id: string;
  stages: TourStage[];
}

export type TourStageStatus =
  | 'entering'
  | 'ready'
  | 'running-actions'
  | 'awaiting-next';

export interface TourSnapshot {
  running: boolean;
  tourId: string | null;
  stageIndex: number;
  stageStatus: TourStageStatus;
}
