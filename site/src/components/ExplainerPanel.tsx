import { useEffect, useReducer, useSyncExternalStore } from 'react';
import {
  subscribe,
  getSnapshot,
  getServerSnapshot,
} from '../lib/toolDebugger';
import useLLMConfig from '../hooks/useLLMConfig';
import {
  initialState,
  reduce,
  runSummarisation,
  type ExplainerState,
  type SummaryState,
} from '../lib/explainerStateMachine';

export default function ExplainerPanel() {
  const debug = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { config } = useLLMConfig();
  const [state, dispatch] = useReducer(reduce, initialState);

  // Translate the debugger snapshot into state-machine events.
  useEffect(() => {
    if (debug.mode === 'running') {
      dispatch({ type: 'MODE_RUNNING' });
    } else if (!debug.pending) {
      dispatch({ type: 'MODE_PAUSED_NO_PENDING' });
    } else {
      dispatch({ type: 'PENDING', call: debug.pending });
    }
  }, [debug.mode, debug.pending]);

  // Kick off summarisation whenever the python/sql code identity changes.
  // We deliberately do NOT depend on `state` itself — dispatching
  // SUMMARY_LOADING from inside the effect would otherwise change the state
  // reference, run cleanup, abort the in-flight request, and the response
  // would never be displayed. See comments in summariseCode.ts for why this
  // request must stay isolated from the agent's chat history.
  const language =
    state.kind === 'paused-python' ? 'python' : state.kind === 'paused-sql' ? 'sql' : null;
  const code =
    state.kind === 'paused-python'
      ? state.code
      : state.kind === 'paused-sql'
        ? state.sql
        : null;
  const endpoint = config.activeEndpoint;

  useEffect(() => {
    if (language === null || code === null) return;
    if (!endpoint) return;
    const key = `${language}:${code}`;

    const ctrl = new AbortController();
    void runSummarisation({ language, code, key, config, signal: ctrl.signal, dispatch });

    return () => {
      ctrl.abort();
    };
    // `config` is stable across unrelated setting reads (see useLLMConfig);
    // only `endpoint` is a meaningful invalidation trigger here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, code, endpoint]);

  return (
    <section className="explainer-panel" aria-label="Explainer">
      <div className="explainer-header">
        <span className="explainer-title">Explainer</span>
      </div>
      <div className="explainer-body">
        <ExplainerBody state={state} />
      </div>
    </section>
  );
}

function ExplainerBody({ state }: { state: ExplainerState }) {
  if (state.kind === 'empty') return null;

  if (state.kind === 'running') {
    return <p>Running without interruptions. Press Pause to halt.</p>;
  }

  if (state.kind === 'paused-python') {
    return (
      <>
        <p>The model wants to run python with the code above. Press the step button to continue.</p>
        <SummaryView summary={state.summary} />
      </>
    );
  }

  if (state.kind === 'paused-sql') {
    return (
      <>
        <p>The model wants to run SQL with the code above. Press the step button to continue.</p>
        <SummaryView summary={state.summary} />
      </>
    );
  }

  // paused-load
  return (
    <p>
      The model wants to load data from <SafeUrl url={state.url} />. Press Step to continue.
    </p>
  );
}

function SummaryView({ summary }: { summary: SummaryState }) {
  if (summary.status === 'idle' || summary.status === 'loading') {
    return <p className="explainer-summary explainer-summary--loading">Summarising…</p>;
  }
  if (summary.status === 'error') {
    return (
      <p className="explainer-summary explainer-summary--error">
        Could not summarise: {summary.message}
      </p>
    );
  }
  return <p className="explainer-summary">{summary.text}</p>;
}

function SafeUrl({ url }: { url: string }) {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    return (
      <a href={parsed.toString()} target="_blank" rel="noopener noreferrer">
        {parsed.toString()}
      </a>
    );
  }
  return <code>{url}</code>;
}
