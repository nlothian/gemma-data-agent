import { useState, useCallback, useSyncExternalStore } from 'react';
import {
  subscribe,
  getSnapshot,
  getServerSnapshot,
  setActiveTab,
  type PaneKind,
  type PaneStatus,
} from '../lib/executionPanelStore';
import useExecutionPanelHeight, {
  MIN_HEIGHT,
  MAX_HEIGHT,
} from '../hooks/useExecutionPanelHeight';
import CodeView from './CodeView';
import DataPanel from './DataPanel';
import PythonOutput from './PythonOutput';
import SqlResultGrid from './SqlResultGrid';
import { ChevronDownIcon } from './Icons';

const PYTHON_PLACEHOLDER = '# Awaiting RunPython call';
const SQL_PLACEHOLDER = '-- Awaiting RunSQL call';

export default function ExecutionPanel() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const active = snap.activeTab;
  const [codeFolded, setCodeFolded] = useState(false);
  const { height, setHeight } = useExecutionPanelHeight();

  const pythonSource =
    snap.python.source.length > 0 ? snap.python.source : PYTHON_PLACEHOLDER;
  const sqlSource =
    snap.sql.source.length > 0 ? snap.sql.source : SQL_PLACEHOLDER;

  const toggleFold = () => setCodeFolded((v) => !v);

  const onResizeHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const startY = e.clientY;
      const startHeight = height;
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('exec-resizing');

      const onMove = (ev: PointerEvent): void => {
        setHeight(startHeight + (ev.clientY - startY));
      };
      const onUp = (ev: PointerEvent): void => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('exec-resizing');
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [height, setHeight],
  );

  const onResizeHandleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = 16;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHeight(height + step);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHeight(height - step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setHeight(MAX_HEIGHT);
      } else if (e.key === 'End') {
        e.preventDefault();
        setHeight(MIN_HEIGHT);
      }
    },
    [height, setHeight],
  );

  return (
    <section className="exec-panel" style={{ height }} aria-label="Execution panel">
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
            <div className="exec-editor-section" data-folded={codeFolded}>
              <div className="exec-editor-bar">
                <button
                  type="button"
                  className="exec-fold-btn"
                  onClick={toggleFold}
                  aria-expanded={!codeFolded}
                  aria-label={codeFolded ? 'Unfold code' : 'Fold code'}
                  title={codeFolded ? 'Unfold code' : 'Fold code'}
                >
                  <ChevronDownIcon
                    size={14}
                    style={{
                      transform: codeFolded ? 'rotate(-90deg)' : 'rotate(0deg)',
                      transition: 'transform 120ms ease',
                    }}
                  />
                  <span>Code</span>
                </button>
              </div>
              <div className="exec-editor">
                {active === 'python' ? (
                  <CodeView code={pythonSource} language="python" />
                ) : (
                  <CodeView code={sqlSource} language="sql" />
                )}
              </div>
            </div>
            {active === 'python' ? (
              <PythonOutput
                stdout={snap.python.stdout}
                stderr={snap.python.stderr}
                errorMessage={snap.python.errorMessage}
                result={snap.python.result}
                status={snap.python.status}
                images={snap.python.images}
                codeFolded={codeFolded}
                onToggleFold={toggleFold}
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
      <div
        className="exec-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize execution panel"
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={MAX_HEIGHT}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={onResizeHandlePointerDown}
        onKeyDown={onResizeHandleKeyDown}
      />
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
