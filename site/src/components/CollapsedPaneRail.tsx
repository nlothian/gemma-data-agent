import { useEffect, useRef, useState } from 'react';
import {
  setExecCollapsed,
  setExplainerCollapsed,
  useRawPaneCollapse,
  usePaneCollapse,
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
  const raw = useRawPaneCollapse();
  const effective = usePaneCollapse();
  const reactViewExpanded = useReactViewExpanded();
  const execTabRef = useRef<HTMLButtonElement>(null);
  const explainerTabRef = useRef<HTMLButtonElement>(null);

  const showExec = raw.exec;
  const showExplainer = raw.explainer && !reactViewExpanded;
  const forceExpanded = !effective.exec && !effective.explainer;

  useRestoreFocusOnMount('rail-exec-tab', execTabRef, showExec);
  useRestoreFocusOnMount('rail-explainer-tab', explainerTabRef, showExplainer);

  if (forceExpanded || (!showExec && !showExplainer)) return null;

  return (
    <div className="pane-rail" aria-label="Collapsed panes">
      {showExec && (
        <button
          ref={execTabRef}
          type="button"
          className="pane-rail-tab pane-rail-tab--exec"
          aria-label="Expand Agents pane"
          aria-expanded={false}
          aria-controls="exec-panel"
          title="Expand Agents"
          onClick={() => setExecCollapsed(false)}
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
          onClick={() => setExplainerCollapsed(false)}
        >
          <ExpandContentIcon size={16} />
          <span className="pane-rail-label">Explainer</span>
        </button>
      )}
    </div>
  );
}
