import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
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
  findEntry,
  type ExplainerEntry,
  type ExplainerHistoryState,
  type SummaryState,
} from '../lib/explainerStateMachine';
import {
  InfoIcon,
  ClearAllIcon,
  DatabaseIcon,
  RobotIcon,
  DataTableIcon,
  CompressIcon,
  PythonLogoIcon,
  ReactLogoIcon,
} from './Icons';
import CompactionPreviewOverlay from './CompactionPreviewOverlay';

const SNIPPET_LEN = 14;

export default function ExplainerPanel() {
  const debug = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { config } = useLLMConfig();
  const [state, dispatch] = useReducer(reduce, initialState);
  const [previewOpen, setPreviewOpen] = useState(false);

  const activeEntry = findEntry(state, state.activeId);

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

  useEffect(() => {
    if (activeEntry?.kind !== 'paused-compaction') setPreviewOpen(false);
  }, [activeEntry?.kind]);

  // Kick off summarisation for the active entry's code/sql/prompt. We trigger
  // off the entry's id so switching tabs (or appending a new tab) re-evaluates,
  // and we early-out if a summary is already loading/ready/errored — switching
  // back to an old tab must not re-fetch.
  const language: 'python' | 'sql' | 'react' | 'subagent' | null =
    activeEntry?.kind === 'paused-python'
      ? 'python'
      : activeEntry?.kind === 'paused-sql'
        ? 'sql'
        : activeEntry?.kind === 'paused-react'
          ? 'react'
          : activeEntry?.kind === 'paused-subagent'
            ? 'subagent'
            : null;
  const code =
    activeEntry?.kind === 'paused-python'
      ? activeEntry.code
      : activeEntry?.kind === 'paused-sql'
        ? activeEntry.sql
        : activeEntry?.kind === 'paused-react'
          ? activeEntry.code
          : activeEntry?.kind === 'paused-subagent'
            ? activeEntry.prompt
            : null;
  const summaryStatus =
    activeEntry && 'summary' in activeEntry ? activeEntry.summary.status : null;
  const entryId = activeEntry?.id ?? null;
  const endpoint = config.activeEndpoint;

  useEffect(() => {
    if (language === null || code === null || entryId === null) return;
    if (!endpoint) return;
    if (summaryStatus !== 'idle') return;

    const ctrl = new AbortController();
    void runSummarisation({ language, code, entryId, config, signal: ctrl.signal, dispatch });

    return () => {
      ctrl.abort();
    };
    // `config` is stable across unrelated setting reads (see useLLMConfig);
    // only `endpoint` is a meaningful invalidation trigger here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, code, entryId, summaryStatus, endpoint]);

  return (
    <>
      <section
        className="explainer-panel"
        data-tour-id="exec.explainerPanel"
        aria-label="Explainer"
      >
        <div className="explainer-header">
          <span className="explainer-title">Explainer</span>
        </div>
        {state.entries.length > 0 && (
          <ExplainerTabs state={state} dispatch={dispatch} />
        )}
        <div className="explainer-body">
          {activeEntry ? (
            <EntryBody
              entry={activeEntry}
              onShowCompaction={() => setPreviewOpen(true)}
            />
          ) : (
            <LiveModeBody liveMode={state.liveMode} />
          )}
        </div>
      </section>
      {previewOpen && activeEntry?.kind === 'paused-compaction' && (
        <CompactionPreviewOverlay
          messages={activeEntry.messages}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
}

function ExplainerTabs({
  state,
  dispatch,
}: {
  state: ExplainerHistoryState;
  dispatch: React.Dispatch<{ type: 'SET_ACTIVE'; id: string } | { type: 'CLEAR_ALL' }>;
}) {
  return (
    <div className="explainer-tabs" role="tablist" aria-label="Explanation history">
      {state.entries.map((entry) => (
        <ExplainerTab
          key={entry.id}
          entry={entry}
          active={entry.id === state.activeId}
          onSelect={() => dispatch({ type: 'SET_ACTIVE', id: entry.id })}
        />
      ))}
      <button
        type="button"
        className="explainer-tab-clear"
        aria-label="Clear all explanations"
        title="Clear all"
        onClick={() => dispatch({ type: 'CLEAR_ALL' })}
      >
        <ClearAllIcon size={16} />
      </button>
    </div>
  );
}

function ExplainerTab({
  entry,
  active,
  onSelect,
}: {
  entry: ExplainerEntry;
  active: boolean;
  onSelect: () => void;
}) {
  const { icon, snippet, fullText } = describeTab(entry);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active}
      className="explainer-tab"
      onClick={onSelect}
      title={fullText}
    >
      <span className="explainer-tab-icon">{icon}</span>
      <span className="explainer-tab-label">{snippet}</span>
    </button>
  );
}

function describeTab(entry: ExplainerEntry): {
  icon: React.ReactNode;
  snippet: string;
  fullText: string;
} {
  switch (entry.kind) {
    case 'paused-python':
      return { icon: <PythonLogoIcon size={12} />, snippet: truncate(entry.code), fullText: entry.code };
    case 'paused-react':
      return { icon: <ReactLogoIcon size={12} />, snippet: truncate(entry.code), fullText: entry.code };
    case 'paused-sql':
      return { icon: <DatabaseIcon size={14} />, snippet: truncate(entry.sql), fullText: entry.sql };
    case 'paused-subagent':
      return { icon: <RobotIcon size={14} />, snippet: truncate(entry.prompt), fullText: entry.prompt };
    case 'paused-load': {
      let label = entry.url;
      try {
        label = new URL(entry.url).hostname;
      } catch {
        // not a parseable URL — fall back to truncated raw value
      }
      return { icon: <DataTableIcon size={14} />, snippet: truncate(label), fullText: entry.url };
    }
    case 'paused-compaction': {
      const label = `${entry.messages.length} msgs`;
      return { icon: <CompressIcon size={14} />, snippet: label, fullText: label };
    }
  }
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= SNIPPET_LEN) return oneLine || '—';
  return oneLine.slice(0, SNIPPET_LEN) + '…';
}

function LiveModeBody({ liveMode }: { liveMode: ExplainerHistoryState['liveMode'] }) {
  if (liveMode === 'running') {
    return <p>Running without interruptions. Press Stop to halt.</p>;
  }
  return null;
}

function EntryBody({
  entry,
  onShowCompaction,
}: {
  entry: ExplainerEntry;
  onShowCompaction: () => void;
}) {
  if (entry.kind === 'paused-python') {
    return (
      <>
        <p>The model wants to run python with the code above. Press the step button to continue.</p>
        <SummaryView summary={entry.summary} />
      </>
    );
  }

  if (entry.kind === 'paused-sql') {
    return (
      <>
        <p>The model wants to run SQL with the code above. Press the step button to continue.</p>
        <SummaryView summary={entry.summary} />
      </>
    );
  }

  if (entry.kind === 'paused-react') {
    return (
      <>
        <p>The model wants to render a React component with the code above. Press the step button to continue.</p>
        <SummaryView summary={entry.summary} />
      </>
    );
  }

  if (entry.kind === 'paused-subagent') {
    return (
      <>
        <p>The main agent wants to create a sub agent. It does this to save context in the main agent thread.</p>
        <SummaryView summary={entry.summary} />
      </>
    );
  }

  if (entry.kind === 'paused-compaction') {
    return (
      <>
        <p>Compaction is required because context is above 90%. Press the Compaction button to run it.</p>
        <button
          type="button"
          className="explainer-show-me"
          onClick={onShowCompaction}
        >
          <InfoIcon size={14} />
          <span>Show me</span>
        </button>
      </>
    );
  }

  // paused-load
  return (
    <p>
      The model wants to load data from <SafeUrl url={entry.url} />. Press Step to continue.
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
