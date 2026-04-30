import { useSyncExternalStore } from 'react';
import {
  subscribe,
  getSnapshot,
  getServerSnapshot,
  type PaneStatus,
} from '../lib/executionPanelStore';

function isBusy(status: PaneStatus): boolean {
  return status === 'pending' || status === 'running';
}

export default function Throbber() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const labels: string[] = [];
  if (snap.restoring) {
    // Restore takes precedence: nothing else can run until it clears.
    labels.push('Reconstructing state');
  } else {
    if (snap.llm.modelDownload) {
      const verb = snap.llm.modelDownload.fromCache ? 'Loading' : 'Downloading';
      labels.push(`${verb} ${snap.llm.modelDownload.label} · ${snap.llm.modelDownload.pct}%`);
    }
    if (isBusy(snap.data.status)) labels.push('Loading data');
    if (isBusy(snap.sql.status)) labels.push('Running SQL');
    if (isBusy(snap.python.status)) labels.push('Running Python');
    if (snap.llm.compacting) labels.push('Compacting');
    else if (snap.llm.active) labels.push('Thinking');
  }

  if (labels.length === 0) return null;
  const label = labels.join(' · ');

  return (
    <div
      className="throbber"
      data-active="true"
      role="status"
      aria-live="polite"
    >
      <span className="throbber-spinner" aria-hidden="true" />
      <span className="throbber-label">{label}</span>
    </div>
  );
}
