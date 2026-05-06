import { useState, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import * as panel from '../lib/executionPanelStore';
import {
  subscribe,
  getSnapshot,
  getServerSnapshot,
  setActiveTab,
  type PaneKind,
  type PaneStatus,
} from '../lib/executionPanelStore';
import * as agentFeatures from '../lib/agentFeaturesStore';
import { runPython, runReact, runSQL } from '../lib/agentTools';
import useExecutionPanelHeight, {
  MIN_HEIGHT,
  MAX_HEIGHT,
} from '../hooks/useExecutionPanelHeight';
import CodeView from './CodeView';
import DataPanel from './DataPanel';
import PythonOutput from './PythonOutput';
import ReactPanel from './ReactPanel';
import SqlResultGrid from './SqlResultGrid';
import SubAgentsPane from './SubAgentsPane';
import * as subAgentStore from '../lib/subAgents/store';
import { ChevronDownIcon, PlayIcon } from './Icons';

const PYTHON_PLACEHOLDER = '# Awaiting RunPython call';
const SQL_PLACEHOLDER = '-- Awaiting RunSQL call';
const REACT_PLACEHOLDER = '// Awaiting RunReact call';

function deriveSubAgentStatus(
  runs: ReadonlyArray<{ status: 'running' | 'done' | 'error' | 'aborted' }>,
): PaneStatus {
  if (runs.length === 0) return 'idle';
  if (runs.some((r) => r.status === 'running')) return 'running';
  const last = runs[runs.length - 1];
  if (last.status === 'error') return 'error';
  if (last.status === 'aborted') return 'aborted';
  return 'done';
}

export default function ExecutionPanel() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const subAgents = useSyncExternalStore(
    subAgentStore.subscribe,
    subAgentStore.getSnapshot,
    subAgentStore.getServerSnapshot,
  );
  const features = useSyncExternalStore(
    agentFeatures.subscribe,
    agentFeatures.getSnapshot,
    agentFeatures.getServerSnapshot,
  );
  const active = snap.activeTab;
  const subAgentStatus = deriveSubAgentStatus(subAgents.runs);
  const [codeFolded, setCodeFolded] = useState(false);
  const [reactViewExpanded, setReactViewExpanded] = useState(false);
  const { height, setHeight } = useExecutionPanelHeight();

  const tabVisible: Record<PaneKind, boolean> = {
    data: !!features.dataLoading,
    python: !!features.runPython,
    sql: !!features.runSql,
    react: !!features.runReact,
    subagents: true,
  };

  useEffect(() => {
    if (!tabVisible[active]) setActiveTab('subagents');
  }, [active, tabVisible.data, tabVisible.python, tabVisible.sql, tabVisible.react]);

  useEffect(() => {
    if (reactViewExpanded) {
      document.body.classList.add('react-view-expanded');
      return () => document.body.classList.remove('react-view-expanded');
    }
  }, [reactViewExpanded]);

  useEffect(() => {
    if (active !== 'react' && reactViewExpanded) setReactViewExpanded(false);
  }, [active, reactViewExpanded]);

  const [editedPython, setEditedPython] = useState<string | null>(null);
  const [editedSql, setEditedSql] = useState<string | null>(null);
  const [editedReact, setEditedReact] = useState<string | null>(null);

  useEffect(() => {
    setEditedPython(null);
    if (snap.python.source) setCodeFolded(false);
  }, [snap.python.source]);
  useEffect(() => {
    setEditedSql(null);
    if (snap.sql.source) setCodeFolded(false);
  }, [snap.sql.source]);
  useEffect(() => {
    setEditedReact(null);
    if (snap.react.source) setCodeFolded(false);
  }, [snap.react.source]);
  // Also unfold on the canonical "new RunReact call" signal — catches the
  // case where the agent re-runs identical code (source string unchanged,
  // so the source-based effect above stays silent) but the user had folded
  // the editor in the meantime. We do NOT touch `reactViewExpanded` here:
  // if the user had maximized the View, leave it maximized.
  useEffect(() => {
    if (snap.react.status === 'pending') setCodeFolded(false);
  }, [snap.react.status]);

  const pythonValue = editedPython ?? snap.python.source;
  const sqlValue = editedSql ?? snap.sql.source;
  const reactValue = editedReact ?? snap.react.source;
  const isPythonEdited =
    editedPython !== null && editedPython !== snap.python.source;
  const isSqlEdited = editedSql !== null && editedSql !== snap.sql.source;
  const isReactEdited =
    editedReact !== null && editedReact !== snap.react.source;
  const pythonBusy =
    snap.python.status === 'pending' || snap.python.status === 'running';
  const sqlBusy = snap.sql.status === 'pending' || snap.sql.status === 'running';
  const reactBusy =
    snap.react.status === 'pending' || snap.react.status === 'running';

  const toggleFold = () => setCodeFolded((v) => !v);

  const handleRun = useCallback(async () => {
    if (active === 'python') {
      const code = editedPython ?? snap.python.source;
      if (code.length === 0 || pythonBusy) return;
      panel.setPending('python', code);
      panel.setRunning('python');
      const res = await runPython(code);
      panel.setPythonResult(res);
    } else if (active === 'sql') {
      const sqlText = editedSql ?? snap.sql.source;
      if (sqlText.length === 0 || sqlBusy) return;
      panel.setPending('sql', sqlText);
      panel.setRunning('sql');
      const res = await runSQL(sqlText);
      panel.setSqlResult('error' in res ? res : res.panel);
    } else if (active === 'react') {
      const code = editedReact ?? snap.react.source;
      if (code.length === 0 || reactBusy) return;
      panel.setPending('react', code);
      panel.setRunning('react');
      const res = await runReact(code);
      panel.setReactResult(res);
    }
  }, [
    active,
    editedPython,
    editedSql,
    editedReact,
    snap.python.source,
    snap.sql.source,
    snap.react.source,
    pythonBusy,
    sqlBusy,
    reactBusy,
  ]);

  const canRun =
    (active === 'python' && isPythonEdited && !pythonBusy && pythonValue.length > 0) ||
    (active === 'sql' && isSqlEdited && !sqlBusy && sqlValue.length > 0) ||
    (active === 'react' && isReactEdited && !reactBusy && reactValue.length > 0);

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
        {tabVisible.data && (
          <TabButton
            kind="data"
            active={active === 'data'}
            status={snap.data.status}
          />
        )}
        {tabVisible.python && (
          <TabButton
            kind="python"
            active={active === 'python'}
            status={snap.python.status}
          />
        )}
        {tabVisible.sql && (
          <TabButton
            kind="sql"
            active={active === 'sql'}
            status={snap.sql.status}
          />
        )}
        {tabVisible.react && (
          <TabButton
            kind="react"
            active={active === 'react'}
            status={snap.react.status}
          />
        )}
        <TabButton
          kind="subagents"
          active={active === 'subagents'}
          status={subAgentStatus}
        />
        <FeatureSelector features={features} />
      </div>
      <div className="exec-body">
        {active === 'subagents' ? (
          <SubAgentsPane />
        ) : active === 'data' ? (
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
                <button
                  type="button"
                  className="exec-play-btn"
                  onClick={handleRun}
                  disabled={!canRun}
                  aria-label="Run edited code"
                  title={
                    canRun
                      ? 'Run edited code'
                      : 'Edit the code to enable running'
                  }
                >
                  <PlayIcon size={14} />
                  <span>Run</span>
                </button>
              </div>
              <div className="exec-editor">
                {active === 'python' ? (
                  <CodeView
                    code={pythonValue}
                    language="python"
                    editable
                    onChange={setEditedPython}
                    placeholder={PYTHON_PLACEHOLDER}
                  />
                ) : active === 'sql' ? (
                  <CodeView
                    code={sqlValue}
                    language="sql"
                    editable
                    onChange={setEditedSql}
                    placeholder={SQL_PLACEHOLDER}
                  />
                ) : (
                  <CodeView
                    code={reactValue}
                    language="tsx"
                    editable
                    onChange={setEditedReact}
                    placeholder={REACT_PLACEHOLDER}
                  />
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
            ) : active === 'sql' ? (
              <SqlResultGrid
                tabular={snap.sql.tabular}
                errorMessage={snap.sql.errorMessage}
                status={snap.sql.status}
              />
            ) : (
              <ReactPanel
                state={snap.react}
                expanded={reactViewExpanded}
                onToggleExpand={() => setReactViewExpanded((v) => !v)}
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
  const label =
    kind === 'python' ? 'Python'
      : kind === 'sql' ? 'SQL'
      : kind === 'react' ? 'React'
      : kind === 'subagents' ? 'SubAgents'
      : 'Data';
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

interface FeatureSelectorProps {
  features: ReturnType<typeof agentFeatures.getSnapshot>;
}

const FEATURE_OPTIONS: ReadonlyArray<{
  key: 'dataLoading' | 'runSql' | 'runPython' | 'runReact';
  label: string;
}> = [
  { key: 'dataLoading', label: 'Data Loading' },
  { key: 'runSql', label: 'SQL' },
  { key: 'runPython', label: 'Python' },
  { key: 'runReact', label: 'React' },
];

function FeatureSelector({ features }: FeatureSelectorProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="exec-feature-selector" ref={wrapRef}>
      <button
        type="button"
        className="exec-feature-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Feature selector"
      >
        <span>Feature selector</span>
        <ChevronDownIcon size={12} />
      </button>
      {open && (
        <div className="exec-feature-popover" role="menu">
          {FEATURE_OPTIONS.map(({ key, label }) => (
            <label key={key} className="exec-feature-option">
              <input
                type="checkbox"
                checked={!!features[key]}
                onChange={(e) => agentFeatures.setFeature(key, e.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
