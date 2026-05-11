import { useEffect, useRef, useState } from 'react';
import {
  restore,
  usePaneLayout,
  useRestoreFocusOnMount,
} from '../lib/paneCollapseStore';
import { ExpandContentIcon } from './Icons';

function useReactViewExpanded(): boolean {
  const [expanded, setExpanded] = useState<boolean>(() =>
    document.body.classList.contains('react-view-expanded'),
  );
  useEffect(() => {
    const update = () =>
      setExpanded(document.body.classList.contains('react-view-expanded'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return expanded;
}

export default function CollapsedPaneRail(): JSX.Element | null {
  const layout = usePaneLayout();
  const reactViewExpanded = useReactViewExpanded();
  const agentsTabRef = useRef<HTMLButtonElement>(null);
  const explainerTabRef = useRef<HTMLButtonElement>(null);

  const showAgents = layout.agents === 'minimized';
  const showExplainer = layout.explainer === 'minimized' && !reactViewExpanded;

  useRestoreFocusOnMount('rail-agents-tab', agentsTabRef, showAgents);
  useRestoreFocusOnMount('rail-explainer-tab', explainerTabRef, showExplainer);

  if (!showAgents && !showExplainer) return null;

  return (
    <div className="pane-rail" aria-label="Collapsed panes">
      {showAgents && (
        <button
          ref={agentsTabRef}
          type="button"
          className="pane-rail-tab pane-rail-tab--exec"
          aria-label="Expand Agents pane"
          aria-expanded={false}
          aria-controls="exec-panel"
          title="Expand Agents"
          onClick={() => restore('agents')}
        >
          <ExpandContentIcon size={16} />
          <span className="pane-rail-label">Agents</span>
        </button>
      )}
      {showExplainer && (
        <button
          ref={explainerTabRef}
          type="button"
          className="pane-rail-tab pane-rail-tab--explainer"
          aria-label="Expand Explainer pane"
          aria-expanded={false}
          aria-controls="explainer-panel"
          title="Expand Explainer"
          onClick={() => restore('explainer')}
        >
          <ExpandContentIcon size={16} />
          <span className="pane-rail-label">Explainer</span>
        </button>
      )}
    </div>
  );
}
