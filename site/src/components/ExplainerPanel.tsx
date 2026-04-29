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
  summaryKey,
  type ExplainerState,
  type SummaryState,
} from '../lib/explainerStateMachine';
import { summariseCode } from '../lib/summariseCode';

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

  // Kick off summarisation when we land on a python/sql paused state. The
  // summariser issues an isolated request — see comments in summariseCode.ts
  // for why it must not share the agent's chat history.
  const key = summaryKey(state);
  useEffect(() => {
    if (state.kind !== 'paused-python' && state.kind !== 'paused-sql') return;
    if (state.summary.status !== 'idle') return;
    if (!config.activeEndpoint) return;
    const k = key;
    if (k === null) return;

    const ctrl = new AbortController();
    dispatch({ type: 'SUMMARY_LOADING', key: k });

    const language = state.kind === 'paused-python' ? 'python' : 'sql';
    const code = state.kind === 'paused-python' ? state.code : state.sql;

    summariseCode(language, code, config, ctrl.signal)
      .then((text) => {
        if (ctrl.signal.aborted) return;
        dispatch({ type: 'SUMMARY_READY', key: k, text });
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        dispatch({ type: 'SUMMARY_ERROR', key: k, message });
      });

    return () => {
      ctrl.abort();
    };
  }, [state.kind, key, state, config]);

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
