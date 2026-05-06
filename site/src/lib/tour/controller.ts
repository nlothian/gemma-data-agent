/**
 * Tour controller — observer store driving the active tour and stage.
 *
 * Mirrors the pattern used by `toolDebugger` and `agentFeaturesStore`:
 * a singleton snapshot, a Set of listeners, and `useSyncExternalStore`
 * compatible `subscribe` / `getSnapshot` exports.
 */

import type { TourDefinition, TourSnapshot, TourStage, TourStageStatus } from './types';
import { performAction } from './actions';

const INITIAL: TourSnapshot = {
  running: false,
  tourId: null,
  stageIndex: 0,
  stageStatus: 'entering',
};

let snapshot: TourSnapshot = INITIAL;
let activeDef: TourDefinition | null = null;
let actionGen = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function setSnapshot(next: TourSnapshot): void {
  snapshot = next;
  notify();
}

function setStatus(stageStatus: TourStageStatus): void {
  setSnapshot({ ...snapshot, stageStatus });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): TourSnapshot {
  return snapshot;
}

export function getServerSnapshot(): TourSnapshot {
  return INITIAL;
}

export function getActiveDefinition(): TourDefinition | null {
  return activeDef;
}

export function getCurrentStage(): TourStage | null {
  if (!activeDef) return null;
  return activeDef.stages[snapshot.stageIndex] ?? null;
}

async function runStageActions(stage: TourStage, gen: number): Promise<void> {
  if (!stage.onEnter || stage.onEnter.length === 0) {
    setStatus('awaiting-next');
    return;
  }
  setStatus('running-actions');
  for (const step of stage.onEnter) {
    if (gen !== actionGen) return;
    if (step.delayMs && step.delayMs > 0) {
      await new Promise((r) => setTimeout(r, step.delayMs));
      if (gen !== actionGen) return;
    }
    try {
      await performAction(step.action, step.params ?? ({} as never));
    } catch (err) {
      console.warn('tour: action failed', step.action, err);
    }
  }
  if (gen !== actionGen) return;
  if (stage.next === 'auto-after-actions') {
    next();
  } else {
    setStatus('awaiting-next');
  }
}

function enterStage(index: number): void {
  if (!activeDef) return;
  const stage = activeDef.stages[index];
  if (!stage) {
    end();
    return;
  }
  const gen = ++actionGen;
  setSnapshot({
    running: true,
    tourId: activeDef.id,
    stageIndex: index,
    stageStatus: 'entering',
  });
  // One frame later, transition to ready and start actions. This matches
  // the "clear markdown, transition smoothly, then perform actions" flow.
  requestAnimationFrame(() => {
    if (gen !== actionGen) return;
    setStatus('ready');
    void runStageActions(stage, gen);
  });
}

export function startTour(def: TourDefinition): void {
  activeDef = def;
  enterStage(0);
}

export function next(): void {
  if (!activeDef) return;
  const nextIndex = snapshot.stageIndex + 1;
  if (nextIndex >= activeDef.stages.length) {
    end();
    return;
  }
  enterStage(nextIndex);
}

export function end(): void {
  activeDef = null;
  actionGen++;
  setSnapshot(INITIAL);
}
