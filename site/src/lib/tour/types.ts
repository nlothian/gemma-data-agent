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
  /**
   * Force the tour card to a specific side of the placement anchor. When
   * unset the overlay picks the side with the most free space. Use this
   * when the auto-picker would land the card under another fixed overlay
   * (e.g. the Sourcecode drawer) that the spotlight cutout doesn't model
   * as occupied space.
   */
  placement?: 'right' | 'below' | 'left' | 'above';
  /**
   * Anchor the card to a single cutout instead of the union of all cutouts.
   * Required when placement is set and `cutouts` has more than one entry,
   * otherwise the placement is ambiguous. The other cutouts still draw a
   * spotlight but are treated as blockers — the card is shifted on the
   * cross-axis to avoid overlapping them.
   */
  placementAnchor?: CutoutId;
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
