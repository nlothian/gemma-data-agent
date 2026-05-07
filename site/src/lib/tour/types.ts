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
  /**
   * Actions to run when the user presses Next, before advancing to the next
   * stage. Use this when a stage should set things up on enter, then wait for
   * an explicit user gesture before triggering the side-effect (e.g. show the
   * code first, run it on Next).
   */
  onExit?: TourActionStep[];
  next?: 'manual' | 'auto-after-actions';
  /**
   * Pin the tour-card width (px). Overrides the auto golden-ratio sizing —
   * use only when measurement gives a poor result (e.g. embedded media).
   */
  cardWidth?: number;
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
