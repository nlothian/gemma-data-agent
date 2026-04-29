import { useEffect, useState } from 'react';

const SHAKE_INTERVAL_MS = 5000;
const SHAKE_DURATION_MS = 400;

export function scheduleShake(
  active: boolean,
  onShake: (shaking: boolean) => void,
  intervalMs: number = SHAKE_INTERVAL_MS,
  durationMs: number = SHAKE_DURATION_MS,
): () => void {
  if (!active) return () => {};

  onShake(true);
  let stopTimeout = setTimeout(() => onShake(false), durationMs);

  const interval = setInterval(() => {
    onShake(true);
    clearTimeout(stopTimeout);
    stopTimeout = setTimeout(() => onShake(false), durationMs);
  }, intervalMs);

  return () => {
    clearInterval(interval);
    clearTimeout(stopTimeout);
    onShake(false);
  };
}

export function useAttentionShake(active: boolean): boolean {
  const [shaking, setShaking] = useState(false);
  useEffect(() => scheduleShake(active, setShaking), [active]);
  return shaking;
}
