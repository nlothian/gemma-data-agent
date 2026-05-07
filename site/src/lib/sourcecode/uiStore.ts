/**
 * Pub-sub for the Sourcecode overlay's open/closed state. The menu button
 * (an isolated React island in the nav) and the overlay host (mounted at
 * the layout level) live in different islands, so they coordinate through
 * this module-level store rather than props.
 */

let open = false;
const listeners = new Set<() => void>();

export function getSnapshot(): boolean {
  return open;
}

export function getServerSnapshot(): boolean {
  return false;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function openSourcecode(): void {
  if (open) return;
  open = true;
  emit();
}

export function closeSourcecode(): void {
  if (!open) return;
  open = false;
  emit();
}

export function toggleSourcecode(): void {
  open = !open;
  emit();
}
