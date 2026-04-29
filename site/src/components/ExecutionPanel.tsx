import { useSyncExternalStore } from 'react';
import {
  subscribe,
  getSnapshot,
  getServerSnapshot,
  setActiveTab,
  type PaneKind,
  type PaneStatus,
} from '../lib/executionPanelStore';
import CodeView from './CodeView';
import DataPanel from './DataPanel';
import PythonOutput from './PythonOutput';
import SqlResultGrid from './SqlResultGrid';

const PYTHON_PLACEHOLDER = '# Awaiting RunPython call';
const SQL_PLACEHOLDER = '-- Awaiting RunSQL call';

export default function ExecutionPanel() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const active = snap.activeTab;

  const pythonSource =
    snap.python.source.length > 0 ? snap.python.source : PYTHON_PLACEHOLDER;
  const sqlSource =
    snap.sql.source.length > 0 ? snap.sql.source : SQL_PLACEHOLDER;

  return (
    <section className="exec-panel" aria-label="Execution panel">
      <div className="exec-tabs" role="tablist">
        <TabButton
          kind="data"
          active={active === 'data'}
          status={snap.data.status}
        />
        <TabButton
          kind="python"
          active={active === 'python'}
          status={snap.python.status}
        />
        <TabButton
          kind="sql"
          active={active === 'sql'}
          status={snap.sql.status}
        />
      </div>
      <div className="exec-body">
        {active === 'data' ? (
          <DataPanel
            tables={snap.data.tables}
            status={snap.data.status}
            errorMessage={snap.data.errorMessage}
            pendingUrl={snap.data.pendingUrl}
            pendingTable={snap.data.pendingTable}
          />
        ) : (
          <>
            <div className="exec-editor">
              {active === 'python' ? (
                <CodeView code={pythonSource} language="python" />
              ) : (
                <CodeView code={sqlSource} language="sql" />
              )}
            </div>
            {active === 'python' ? (
              <PythonOutput
                stdout={snap.python.stdout}
                stderr={snap.python.stderr}
                errorMessage={snap.python.errorMessage}
                result={snap.python.result}
                status={snap.python.status}
                images={snap.python.images}
              />
            ) : (
              <SqlResultGrid
                tabular={snap.sql.tabular}
                errorMessage={snap.sql.errorMessage}
                status={snap.sql.status}
              />
            )}
          </>
        )}
      </div>
    </section>
  );
}

interface TabButtonProps {
  kind: PaneKind;
  active: boolean;
  status: PaneStatus;
}

function TabButton({ kind, active, status }: TabButtonProps) {
  const label = kind === 'python' ? 'Python' : kind === 'sql' ? 'SQL' : 'Data';
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active}
      className="exec-tab"
      onClick={() => setActiveTab(kind)}
    >
      <StatusDot status={status} />
      <span>{label}</span>
    </button>
  );
}

function StatusDot({ status }: { status: PaneStatus }) {
  return <span className="exec-status-dot" data-status={status} aria-hidden />;
}
