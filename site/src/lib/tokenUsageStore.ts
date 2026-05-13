export interface TokenUsage {
  input: number;
  output: number;
  /**
   * Post-hoc decode rate for the most recent turn — output tokens divided by
   * cumulative time spent inside the model's generate() call(s), excluding
   * tool-dispatch latency. Undefined until the first decode finishes.
   */
  tps?: number;
}

let current: TokenUsage | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function setTokenUsage(usage: TokenUsage | null): void {
  current = usage;
  notify();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): TokenUsage | null {
  return current;
}

export function getServerSnapshot(): TokenUsage | null {
  return null;
}
