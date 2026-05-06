import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import * as subAgentStore from '../lib/subAgents/store';
import MessagesView from './MessagesView';
import type { SubAgentRun, SubAgentStatus } from '../lib/subAgents/store';

export default function SubAgentsPane() {
  const snap = useSyncExternalStore(
    subAgentStore.subscribe,
    subAgentStore.getSnapshot,
    subAgentStore.getServerSnapshot,
  );
  const { runs, activeRunId } = snap;
  const active =
    runs.find((r) => r.id === activeRunId) ?? runs[runs.length - 1] ?? null;

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = (): void => {
      wasAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Snap to bottom when switching to a different run.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    wasAtBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [active?.id]);

  // Keep streaming output in view as long as the user hasn't scrolled away.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [active?.messages, active?.status]);

  if (runs.length === 0) {
    return (
      <div className="exec-subagents-empty">
        No sub-agent runs yet. Sub-agents are spawned when the agent invokes
        <code> RunSubAgent</code> to delegate a subtask.
      </div>
    );
  }

  return (
    <div className="exec-subagents">
      <div className="exec-subagents-tabs" role="tablist">
        {runs.map((r) => (
          <SubAgentTab
            key={r.id}
            run={r}
            active={active?.id === r.id}
            onSelect={() => subAgentStore.setActiveRun(r.id)}
          />
        ))}
      </div>
      <div className="exec-subagents-body" ref={bodyRef}>
        {active ? <SubAgentRunBody run={active} /> : null}
      </div>
    </div>
  );
}

function SubAgentTab({
  run,
  active,
  onSelect,
}: {
  run: SubAgentRun;
  active: boolean;
  onSelect: () => void;
}) {
  const label = run.label.length > 28 ? run.label.slice(0, 28) + '…' : run.label;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active}
      data-status={run.status}
      className="exec-subagent-tab"
      onClick={onSelect}
      title={run.label}
    >
      <SubAgentStatusDot status={run.status} />
      <span>{label}</span>
    </button>
  );
}

function SubAgentStatusDot({ status }: { status: SubAgentStatus }) {
  return <span className="exec-status-dot" data-status={status} aria-hidden />;
}

function SubAgentRunBody({ run }: { run: SubAgentRun }) {
  const last = run.messages[run.messages.length - 1];
  const pendingId =
    run.status === 'running' &&
    last?.role === 'assistant' &&
    last.content === ''
      ? last.id
      : null;
  return (
    <div className="exec-subagent-run">
      {run.status === 'error' && run.errorMessage && (
        <div className="exec-subagent-error">{run.errorMessage}</div>
      )}
      <MessagesView messages={run.messages} pendingAssistantId={pendingId} />
    </div>
  );
}
