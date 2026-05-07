import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import {
  getServerSnapshot,
  getSnapshot,
  subscribe,
} from '../lib/toolDebugger';
import { COMPACTION_TOOL_NAME } from '../lib/autoCompaction';
import { popForceExpand, pushForceExpand } from '../lib/paneCollapseStore';
import SpotlightOverlay from './SpotlightOverlay';
import type { CutoutId } from '../lib/tour/cutouts';

const EXPLAINABLE_TOOLS = new Set<string>([
  'RunPython',
  'RunSQL',
  'RunReact',
  'RunSubAgent',
  'LoadData',
  COMPACTION_TOOL_NAME,
]);

const EMPTY_CUTOUTS: ReadonlyArray<CutoutId> = [];

function cutoutsForTool(toolName: string): ReadonlyArray<CutoutId> {
  if (toolName === 'RunPython' || toolName === 'RunSQL' || toolName === 'RunReact') {
    return ['exec.explainerPanel', 'chat.stepButton', 'chat.playButton', 'exec.codeEditor'];
  }
  if (toolName === 'LoadData') {
    return ['exec.explainerPanel', 'chat.stepButton', 'chat.playButton', 'exec.dataPanel'];
  }
  if (toolName === 'RunSubAgent') {
    return ['exec.explainerPanel', 'chat.stepButton', 'chat.playButton'];
  }
  if (toolName === COMPACTION_TOOL_NAME) {
    return ['exec.explainerPanel', 'chat.compactionRunButton'];
  }
  return EMPTY_CUTOUTS;
}

export default function PauseCoachmark(): JSX.Element | null {
  const debug = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [dismissed, setDismissed] = useState(false);

  const toolName = debug.pending?.toolName ?? null;
  const shouldShow =
    debug.mode === 'paused' &&
    toolName !== null &&
    EXPLAINABLE_TOOLS.has(toolName);

  useEffect(() => {
    if (!shouldShow) setDismissed(false);
  }, [shouldShow]);

  const open = shouldShow && !dismissed;

  useEffect(() => {
    if (!open) return;
    pushForceExpand('pause');
    return () => popForceExpand('pause');
  }, [open]);

  const cutouts = useMemo<ReadonlyArray<CutoutId>>(
    () => (toolName ? cutoutsForTool(toolName) : EMPTY_CUTOUTS),
    [toolName],
  );

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  return <SpotlightOverlay cutouts={cutouts} open={open} onDismiss={handleDismiss} />;
}
