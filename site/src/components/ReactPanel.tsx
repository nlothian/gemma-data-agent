import { useEffect, useRef, useState } from 'react';
import { setReactMountElement } from '../lib/reactSandbox';
import type {
  ReactPaneState,
  PaneStatus,
  ReactCompileErrorView,
  ReactRuntimeErrorView,
} from '../lib/executionPanelStore';
import { MaximizeIcon, MinimizeIcon } from './Icons';

type SubTab = 'console' | 'view';

interface ReactPanelProps {
  state: ReactPaneState;
  codeFolded?: boolean;
  onToggleFold?: () => void;
}

export default function ReactPanel({ state, codeFolded = false, onToggleFold }: ReactPanelProps) {
  const [sub, setSub] = useState<SubTab>('console');
  const viewRef = useRef<HTMLDivElement>(null);

  // Register the View pane mount element with the sandbox so the agent's
  // RunReact call (which runs outside React's render cycle) can find it.
  useEffect(() => {
    setReactMountElement(viewRef.current);
    return () => setReactMountElement(null);
  }, []);

  // When new code arrives (either streaming in from a tool call or a fresh
  // setPending), wipe the previous run's iframe out of the mount element so
  // the View pane shows the placeholder until the new code runs.
  useEffect(() => {
    const el = viewRef.current;
    if (el) el.replaceChildren();
  }, [state.source]);

  const hasCompile = state.compileErrors.length > 0;
  const hasRuntime = state.runtimeErrors.length > 0;
  const hasErrors = hasCompile || hasRuntime;

  // Auto-switch sub-tab on result. On success → View; on errors → Code so the
  // user (and the agent's iteration loop visualization) sees the diagnostics.
  useEffect(() => {
    if (state.status === 'pending') setSub('console');
  }, [state.status]);
  useEffect(() => {
    if (state.status !== 'done' && state.status !== 'error') return;
    setSub(hasErrors ? 'console' : 'view');
  }, [state.resultGeneration, state.status, hasErrors]);

  return (
    <div className="exec-output-wrap">
      <div className="exec-output-subtabs" role="tablist">
        <SubTabButton
          label={
            hasErrors
              ? `Console (${state.compileErrors.length + state.runtimeErrors.length} err)`
              : 'Console'
          }
          active={sub === 'console'}
          onClick={() => setSub('console')}
        />
        <SubTabButton
          label="View"
          active={sub === 'view'}
          onClick={() => setSub('view')}
        />
        {sub === 'view' && onToggleFold && (
          <button
            type="button"
            className="exec-expand-btn"
            onClick={onToggleFold}
            aria-pressed={codeFolded}
            aria-label={codeFolded ? 'Restore code panel' : 'Expand view'}
            title={codeFolded ? 'Restore code panel' : 'Expand view'}
          >
            {codeFolded ? <MinimizeIcon size={14} /> : <MaximizeIcon size={14} />}
            <span>{codeFolded ? 'Restore' : 'Expand'}</span>
          </button>
        )}
      </div>

      <div className="exec-output-pane exec-output-pane-text" hidden={sub !== 'console'}>
        <ErrorList compile={state.compileErrors} runtime={state.runtimeErrors} status={state.status} />
      </div>

      <div
        className="exec-output-pane exec-output-pane-plot"
        hidden={sub !== 'view'}
        style={{ background: '#fff', position: 'relative' }}
      >
        {/* Imperatively-managed mount node — must have NO React children
            ever, or React's reconciler will fight the iframe we append into
            it and throw NotFoundError on the next render. */}
        <div ref={viewRef} style={{ width: '100%', height: '100%' }} />
        {state.resultGeneration === 0 && (
          <div
            className="exec-output-placeholder"
            style={{
              position: 'absolute',
              inset: 0,
              padding: 12,
              pointerEvents: 'none',
            }}
          >
            {placeholderForView(state.status)}
          </div>
        )}
      </div>
    </div>
  );
}

interface ErrorListProps {
  compile: ReactCompileErrorView[];
  runtime: ReactRuntimeErrorView[];
  status: PaneStatus;
}

function ErrorList({ compile, runtime, status }: ErrorListProps) {
  if (compile.length === 0 && runtime.length === 0) {
    return (
      <pre className="exec-output">
        <span className="exec-output-placeholder">{placeholderForConsole(status)}</span>
      </pre>
    );
  }
  return (
    <pre className="exec-output">
      {compile.length > 0 && (
        <span className="exec-error">
          {`Compile errors (${compile.length}):\n`}
          {compile
            .map((e) => {
              const loc = e.line ? ` (${e.line}${e.column ? `:${e.column}` : ''})` : '';
              return `  ${e.message}${loc}`;
            })
            .join('\n')}
          {'\n'}
        </span>
      )}
      {runtime.length > 0 && (
        <span className="exec-stderr">
          {`Runtime errors (${runtime.length}):\n`}
          {runtime
            .map((e) => `  ${e.message}${e.stack ? `\n    ${e.stack.split('\n').slice(0, 3).join('\n    ')}` : ''}`)
            .join('\n')}
        </span>
      )}
    </pre>
  );
}

interface SubTabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function SubTabButton({ label, active, onClick }: SubTabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active}
      className="exec-subtab"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function placeholderForConsole(status: PaneStatus): string {
  switch (status) {
    case 'pending':
      return 'Awaiting Step / Play to execute…';
    case 'running':
      return 'Compiling and rendering…';
    case 'aborted':
      return 'Aborted before execution.';
    case 'done':
      return '(no errors)';
    default:
      return 'Run a RunReact tool call to render a component here.';
  }
}

function placeholderForView(status: PaneStatus): string {
  switch (status) {
    case 'pending':
    case 'running':
      return 'Rendering…';
    case 'error':
      return 'See Code sub-tab for errors.';
    case 'done':
      return 'Re-run to render.';
    default:
      return 'No render yet.';
  }
}
