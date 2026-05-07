import { memo, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import {
  subscribe,
  getSnapshot,
  getServerSnapshot,
} from '../lib/toolDebugger';
import useLLMConfig, { isLLMUnconfigured } from '../hooks/useLLMConfig';
import {
  initialState,
  reduce,
  runSummarisation,
  findEntry,
  type ConversationEntry,
  type ExplainerEntry,
  type ExplainerEvent,
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
  CollapseContentIcon,
  PythonLogoIcon,
  ReactLogoIcon,
  LiveHelpIcon,
  PlayIcon,
} from './Icons';
import {
  setExplainerCollapsed,
  usePaneCollapse,
  useRestoreFocusOnMount,
} from '../lib/paneCollapseStore';
import CompactionPreviewOverlay from './CompactionPreviewOverlay';
import MessagesView from './MessagesView';
import { streamChat, type StreamChatMessage } from '../lib/streamChat';
import { generateId } from '../lib/browser';
import * as tokenUsageStore from '../lib/tokenUsageStore';
import { mapMessagesForLLM } from '../lib/autoCompaction';
import type { ChatMessage } from '../types/chat';
import explainerConversationSystemPrompt from '../prompts/explainerConversationSystemPrompt.md?raw';
import { EXPLAINER_TOOLS, runExplainerTool } from '../lib/explainerTools';

const MAX_STREAMING_CONVERSATIONS = 10;

const SNIPPET_LEN = 14;

export default function ExplainerPanel() {
  const debug = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { config, ready: cfgReady } = useLLMConfig();
  const [state, dispatch] = useReducer(reduce, initialState);
  const [previewOpen, setPreviewOpen] = useState(false);
  const conversationAbortsRef = useRef<Map<string, AbortController>>(new Map());

  const activeEntry = findEntry(state, state.activeId);
  const unconfigured = isLLMUnconfigured(config, cfgReady);
  const streamingConversations = state.entries.filter(
    (e): e is ConversationEntry => e.kind === 'conversation' && e.isStreaming,
  ).length;
  const liveHelpDisabled =
    unconfigured || streamingConversations >= MAX_STREAMING_CONVERSATIONS;

  // Abort streams whose entry id is no longer present (CLEAR_ALL, eviction).
  // Guarded against the per-keystroke / per-token entries-array churn by an
  // id-set comparison so the abort scan only runs when ids actually change.
  const lastEntryIdsRef = useRef<string>('');
  useEffect(() => {
    const ids = state.entries
      .filter((e) => e.kind === 'conversation')
      .map((e) => e.id)
      .join('|');
    if (ids === lastEntryIdsRef.current) return;
    lastEntryIdsRef.current = ids;
    const liveIds = new Set(ids ? ids.split('|') : []);
    for (const [id, ctrl] of conversationAbortsRef.current) {
      if (!liveIds.has(id)) {
        ctrl.abort();
        conversationAbortsRef.current.delete(id);
      }
    }
  }, [state.entries]);

  async function sendExplainerTurn(entryId: string, trimmed: string) {
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: trimmed,
      createdAt: Date.now(),
    };
    const assistantMessageId = generateId();

    const priorEntry = state.entries.find(
      (e): e is ConversationEntry => e.id === entryId && e.kind === 'conversation',
    );
    const priorMessages: ChatMessage[] = priorEntry?.messages ?? [];

    dispatch({
      type: 'CONVERSATION_APPEND_USER',
      entryId,
      userMessage,
      assistantMessageId,
    });

    const requestMessages: StreamChatMessage[] = [
      { role: 'system', content: explainerConversationSystemPrompt },
      ...mapMessagesForLLM(priorMessages),
      { role: 'user', content: trimmed },
    ];

    const controller = new AbortController();
    conversationAbortsRef.current.set(entryId, controller);

    try {
      await streamChat({
        config,
        messages: requestMessages,
        tools: EXPLAINER_TOOLS,
        toolDispatcher: runExplainerTool,
        signal: controller.signal,
        onToken: (delta) =>
          dispatch({ type: 'CONVERSATION_STREAM_TOKEN', entryId, delta }),
        onUsage: (usage) => tokenUsageStore.setTokenUsage(usage),
        onDone: () => dispatch({ type: 'CONVERSATION_STREAM_DONE', entryId }),
        onError: (err) =>
          dispatch({
            type: 'CONVERSATION_STREAM_ERROR',
            entryId,
            message: err?.message ?? String(err),
          }),
      });
    } catch (err) {
      dispatch({
        type: 'CONVERSATION_STREAM_ERROR',
        entryId,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      conversationAbortsRef.current.delete(entryId);
    }
  }

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

  const collapse = usePaneCollapse();
  const collapseBtnRef = useRef<HTMLButtonElement>(null);
  useRestoreFocusOnMount('explainer-collapse-btn', collapseBtnRef, !collapse.explainer);

  if (collapse.explainer) return null;

  return (
    <>
      <section
        id="explainer-panel"
        className="explainer-panel"
        data-tour-id="exec.explainerPanel"
        aria-label="Explainer"
      >
        <div className="explainer-header">
          <span className="explainer-title">Explainer</span>
          <button
            ref={collapseBtnRef}
            type="button"
            className="pane-collapse-btn pane-collapse-btn--explainer"
            aria-label="Collapse Explainer pane"
            aria-expanded={true}
            aria-controls="explainer-panel"
            title="Collapse Explainer"
            onClick={() => setExplainerCollapsed(true)}
          >
            <CollapseContentIcon size={16} />
          </button>
        </div>
        <ExplainerTabs
          state={state}
          dispatch={dispatch}
          liveHelpDisabled={liveHelpDisabled}
          liveHelpTitle={
            unconfigured
              ? 'Live help (model not configured)'
              : streamingConversations >= MAX_STREAMING_CONVERSATIONS
                ? 'Live help (too many streams in flight)'
                : 'Live help'
          }
        />
        <div className="explainer-body">
          {activeEntry ? (
            <EntryBody
              entry={activeEntry}
              unconfigured={unconfigured}
              dispatch={dispatch}
              onShowCompaction={() => setPreviewOpen(true)}
              onSendConversation={sendExplainerTurn}
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
  liveHelpDisabled,
  liveHelpTitle,
}: {
  state: ExplainerHistoryState;
  dispatch: React.Dispatch<ExplainerEvent>;
  liveHelpDisabled: boolean;
  liveHelpTitle: string;
}) {
  const onSelect = useCallback(
    (id: string) => dispatch({ type: 'SET_ACTIVE', id }),
    [dispatch],
  );
  return (
    <div className="explainer-tabs" role="tablist" aria-label="Explanation history">
      {state.entries.map((entry) => (
        <ExplainerTab
          key={entry.id}
          entry={entry}
          active={entry.id === state.activeId}
          onSelect={onSelect}
        />
      ))}
      <div className="explainer-tabs-actions">
        {state.entries.length > 0 && (
          <button
            type="button"
            className="explainer-tab-action"
            aria-label="Clear all explanations"
            title="Clear all"
            onClick={() => dispatch({ type: 'CLEAR_ALL' })}
          >
            <ClearAllIcon size={16} />
          </button>
        )}
        <button
          type="button"
          className="explainer-tab-action"
          aria-label="Start a new explainer conversation"
          title={liveHelpTitle}
          disabled={liveHelpDisabled}
          onClick={() => dispatch({ type: 'NEW_CONVERSATION' })}
        >
          <LiveHelpIcon size={16} />
        </button>
      </div>
    </div>
  );
}

const ExplainerTab = memo(function ExplainerTab({
  entry,
  active,
  onSelect,
}: {
  entry: ExplainerEntry;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const { icon, snippet, fullText } = describeTab(entry);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active}
      data-kind={entry.kind}
      className="explainer-tab"
      onClick={() => onSelect(entry.id)}
      title={fullText}
    >
      <span className="explainer-tab-icon">{icon}</span>
      <span className="explainer-tab-label">{snippet}</span>
    </button>
  );
});

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
    case 'conversation':
      return {
        icon: <LiveHelpIcon size={14} />,
        snippet: entry.title,
        fullText: entry.title,
      };
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
  unconfigured,
  dispatch,
  onShowCompaction,
  onSendConversation,
}: {
  entry: ExplainerEntry;
  unconfigured: boolean;
  dispatch: React.Dispatch<ExplainerEvent>;
  onShowCompaction: () => void;
  onSendConversation: (entryId: string, trimmed: string) => void;
}) {
  switch (entry.kind) {
    case 'paused-python':
      return (
        <>
          <p>The model wants to run python with the code above. Press the step button to continue.</p>
          <SummaryView summary={entry.summary} />
        </>
      );
    case 'paused-sql':
      return (
        <>
          <p>The model wants to run SQL with the code above. Press the step button to continue.</p>
          <SummaryView summary={entry.summary} />
        </>
      );
    case 'paused-react':
      return (
        <>
          <p>The model wants to render a React component with the code above. Press the step button to continue.</p>
          <SummaryView summary={entry.summary} />
        </>
      );
    case 'paused-subagent':
      return (
        <>
          <p>The main agent wants to create a sub agent. It does this to save context in the main agent thread.</p>
          <SummaryView summary={entry.summary} />
        </>
      );
    case 'paused-compaction':
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
    case 'conversation':
      return (
        <ConversationBody
          entry={entry}
          unconfigured={unconfigured}
          dispatch={dispatch}
          onSend={onSendConversation}
        />
      );
    case 'paused-load':
      return (
        <p>
          The model wants to load data from <SafeUrl url={entry.url} />. Press Step to continue.
        </p>
      );
  }
}

function ConversationBody({
  entry,
  unconfigured,
  dispatch,
  onSend,
}: {
  entry: ConversationEntry;
  unconfigured: boolean;
  dispatch: React.Dispatch<ExplainerEvent>;
  onSend: (entryId: string, trimmed: string) => void;
}) {
  const trimmed = entry.draftInput.trim();
  const sendDisabled = entry.isStreaming || unconfigured || trimmed === '';
  const inputDisabled = entry.isStreaming || unconfigured;
  const lastMessage = entry.messages[entry.messages.length - 1];
  const pendingAssistantId = entry.isStreaming ? lastMessage?.id ?? null : null;

  const submit = () => {
    if (sendDisabled) return;
    onSend(entry.id, trimmed);
  };

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      wasAtBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entry.messages]);

  return (
    <div className="explainer-conversation-body">
      <div className="explainer-conversation-scroll" ref={scrollRef}>
        <MessagesView
          messages={entry.messages}
          pendingAssistantId={pendingAssistantId}
          emptyState={
            <p className="explainer-conversation-empty">
              Ask a question to get started.
            </p>
          }
        />
      </div>
      {entry.error && (
        <p className="explainer-summary explainer-summary--error">{entry.error}</p>
      )}
      <form
        className="explainer-conversation-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          className="explainer-conversation-input"
          aria-label="Message"
          placeholder="Question…"
          rows={1}
          value={entry.draftInput}
          disabled={inputDisabled}
          onChange={(e) =>
            dispatch({
              type: 'CONVERSATION_SET_INPUT',
              entryId: entry.id,
              value: e.target.value,
            })
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          className="explainer-conversation-send"
          aria-label="Send message"
          disabled={sendDisabled}
        >
          <PlayIcon size={16} />
        </button>
      </form>
    </div>
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
