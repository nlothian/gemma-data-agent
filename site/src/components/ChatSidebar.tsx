import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import useLLMConfig from '../hooks/useLLMConfig';
import useChatHistory from '../hooks/useChatHistory';
import useChatSidebarWidth, {
  MIN_WIDTH as CHAT_MIN_WIDTH,
  MAX_WIDTH as CHAT_MAX_WIDTH,
} from '../hooks/useChatSidebarWidth';
import { useAttentionShake } from '../hooks/useAttentionShake';
import { streamChat, type StreamChatMessage } from '../lib/streamChat';
import { generateId } from '../lib/browser';
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS } from '../lib/agentTools';
import * as toolDebugger from '../lib/toolDebugger';
import * as executionPanelStore from '../lib/executionPanelStore';
import * as tokenUsageStore from '../lib/tokenUsageStore';
import { restoreRegistryFromIndexedDB, clearAllInputs } from '../lib/duckdb';
import {
  getContextWindowForEndpoint,
  formatTokenCount,
  getPressureLevel,
  type PressureLevel,
} from '../lib/contextWindow';
import {
  buildCompactionContext,
  buildCompactionSlice,
  COMPACTION_TOOL_NAME,
  mapMessagesForLLM,
  maybeAutoCompact,
  runCompaction,
} from '../lib/autoCompaction';
import { renderConversationForGemma } from '../lib/localLlm/toolPrompt';
import { sizeInTokens } from '../lib/localLlm/llmService';
import type { TokenUsage } from '../lib/tokenUsageStore';
import type { ChatMessage } from '../types/chat';
import { isLocalGemmaEndpoint, LOCAL_GEMMA_ENDPOINT } from '../types/llm';
import {
  ChatAddOnIcon,
  ChevronRightIcon,
  CloseIcon,
  CompressIcon,
  PauseIcon,
  PlayIcon,
  StepIcon,
} from './Icons';
import Throbber from './Throbber';
import PressureIndicator from './PressureIndicator';
import {
  parseAssistantContent,
  type AssistantSegment,
} from '../lib/parseAssistantContent';

const MARKDOWN_PLUGINS = [remarkGfm];

let hydratePromise: Promise<void> | null = null;

function hydrateOnce(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    executionPanelStore.setRestoring(true);
    try {
      await restoreRegistryFromIndexedDB();
      await executionPanelStore.restorePanelFromIndexedDB();
    } catch (err) {
      console.warn('hydrateOnce: failed to rehydrate state:', err);
    } finally {
      executionPanelStore.setRestoring(false);
    }
  })();
  return hydratePromise;
}

const MARKDOWN_COMPONENTS = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

interface ChatMessageRowProps {
  message: ChatMessage;
  isPending: boolean;
  onRetry: (id: string) => void;
}

function CollapsibleThinking({ text, done }: { text: string; done: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    if (done && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      setExpanded(false);
    }
  }, [done]);
  return (
    <div className="chat-thinking-block">
      <button
        type="button"
        className="chat-tool-summary"
        data-expanded={expanded ? 'true' : 'false'}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <ChevronRightIcon size={14} />
        <span className="chat-tool-name">Thinking</span>
        {!done && <span className="chat-thinking-pulse" aria-hidden="true" />}
      </button>
      {expanded && (
        <div className="chat-tool-body">
          <pre>
            <code>{text || (done ? '' : '…')}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

function CollapsibleToolCall({
  name,
  args,
  result,
}: {
  name: string;
  args: string;
  result: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="chat-tool-call">
      <button
        type="button"
        className="chat-tool-summary"
        data-expanded={expanded ? 'true' : 'false'}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <ChevronRightIcon size={14} />
        <span className="chat-tool-name">{name}</span>
      </button>
      {expanded && (
        <div className="chat-tool-body">
          <pre>
            <code>{args || '{}'}</code>
          </pre>
          {result === null ? (
            <div className="chat-tool-running">running…</div>
          ) : (
            <pre>
              <code>{result}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function CollapsibleCompacted({
  summary,
  highlight,
}: {
  summary: string;
  highlight: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={'chat-compacted' + (highlight ? ' chat-compacted--attention' : '')}
    >
      <button
        type="button"
        className="chat-tool-summary"
        data-expanded={expanded ? 'true' : 'false'}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <ChevronRightIcon size={14} />
        <span className="chat-tool-name">Compacted</span>
      </button>
      {expanded && (
        <div className="chat-tool-body">
          <pre>
            <code>{summary}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

function AssistantBody({ content }: { content: string }) {
  const segments = useMemo<AssistantSegment[]>(
    () => parseAssistantContent(content),
    [content],
  );
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          if (!seg.text.trim()) return null;
          return (
            <ReactMarkdown
              key={i}
              remarkPlugins={MARKDOWN_PLUGINS}
              components={MARKDOWN_COMPONENTS}
            >
              {seg.text}
            </ReactMarkdown>
          );
        }
        if (seg.kind === 'thinking') {
          return <CollapsibleThinking key={i} text={seg.text} done={seg.done} />;
        }
        return (
          <CollapsibleToolCall
            key={i}
            name={seg.name}
            args={seg.args}
            result={seg.result}
          />
        );
      })}
    </>
  );
}

function renderMessageBody(m: ChatMessage, isPending: boolean) {
  if (isPending) return <span className="chat-typing">…</span>;
  if (m.role === 'assistant' && !m.error) {
    return <AssistantBody content={m.content} />;
  }
  return m.content;
}

const ChatMessageRow = memo(function ChatMessageRow({
  message,
  isPending,
  onRetry,
}: ChatMessageRowProps) {
  const m = message;
  return (
    <div className={`chat-row chat-row-${m.role}`}>
      <div className={'chat-msg chat-msg-' + (m.error ? 'error' : m.role)}>
        {renderMessageBody(m, isPending)}
      </div>
      {m.error && (
        <button
          type="button"
          className="chat-retry"
          onClick={() => onRetry(m.id)}
        >
          Retry
        </button>
      )}
    </div>
  );
});

export default function ChatSidebar() {
  const { config, ready: cfgReady, setThinkingEnabled } = useLLMConfig();
  const {
    history,
    appendMessage,
    updateLastAssistant,
    appendLastAssistantHistory,
    setLastAssistantContent,
    replaceMessages,
    clear,
    flush,
  } = useChatHistory();

  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isOpenMobile, setIsOpenMobile] = useState(false);
  const [highlightCompactedId, setHighlightCompactedId] = useState<string | null>(
    null,
  );
  const { width: sidebarWidth, setWidth: setSidebarWidth } = useChatSidebarWidth();
  const debugger_ = useSyncExternalStore(
    toolDebugger.subscribe,
    toolDebugger.getSnapshot,
    toolDebugger.getServerSnapshot,
  );
  const tokenUsage = useSyncExternalStore(
    tokenUsageStore.subscribe,
    tokenUsageStore.getSnapshot,
    tokenUsageStore.getServerSnapshot,
  );
  const panelSnap = useSyncExternalStore(
    executionPanelStore.subscribe,
    executionPanelStore.getSnapshot,
    executionPanelStore.getServerSnapshot,
  );
  const restoring = panelSnap.restoring;
  const stepShaking = useAttentionShake(Boolean(debugger_.pending));
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const wasAtBottomRef = useRef(true);
  // Mirrors history.messages so that `onDone`'s closure sees the just-streamed
  // assistant turn rather than the stale snapshot captured at sendPrompt time.
  const historyRef = useRef(history.messages);
  useEffect(() => {
    historyRef.current = history.messages;
  }, [history.messages]);

  const unconfigured = useMemo(() => {
    if (!cfgReady) return false;
    const ep = config.activeEndpoint;
    if (!ep) return true;
    if (!isLocalGemmaEndpoint(ep) && !config.apiKeys[ep]) return true;
    if (!config.models[ep]) return true;
    return false;
  }, [cfgReady, config]);

  useEffect(() => {
    void hydrateOnce();
    return () => {
      abortRef.current?.abort();
      toolDebugger.reset();
      executionPanelStore.resetPanel();
    };
  }, []);

  // Track whether the user is pinned near the bottom before each render.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = (): void => {
      wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [history.messages]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--chat-w', sidebarWidth + 'px');
    return () => {
      root.style.removeProperty('--chat-w');
    };
  }, [sidebarWidth]);

  const onResizeHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (window.matchMedia('(max-width: 900px)').matches) return;
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('chat-resizing');

      const onMove = (ev: PointerEvent): void => {
        setSidebarWidth(startWidth + (startX - ev.clientX));
      };
      const onUp = (ev: PointerEvent): void => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('chat-resizing');
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [sidebarWidth, setSidebarWidth],
  );

  const onResizeHandleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = 16;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setSidebarWidth(sidebarWidth + step);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setSidebarWidth(sidebarWidth - step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setSidebarWidth(CHAT_MAX_WIDTH);
      } else if (e.key === 'End') {
        e.preventDefault();
        setSidebarWidth(CHAT_MIN_WIDTH);
      }
    },
    [sidebarWidth, setSidebarWidth],
  );

  const autoGrow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
  }, []);

  const scrollToTop = useCallback(() => {
    wasAtBottomRef.current = false;
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = 0;
    });
  }, []);

  // Compute the post-compaction prompt size for the local-Gemma path so the
  // gauge reflects the surviving context immediately instead of resetting to
  // zero. Cloud endpoints have no client-side tokenizer — return null to fall
  // back to the next response's usage event.
  const estimatePostCompactionUsage = useCallback(
    (msgs: ChatMessage[]): TokenUsage | null => {
      if (!isLocalGemmaEndpoint(config.activeEndpoint)) return null;
      const thinkingEnabled =
        config.thinkingEnabled?.[LOCAL_GEMMA_ENDPOINT] ?? false;
      const prompt = renderConversationForGemma(
        AGENT_SYSTEM_PROMPT + buildCompactionContext(msgs),
        mapMessagesForLLM(msgs),
        AGENT_TOOLS,
        thinkingEnabled,
      );
      const tokens = sizeInTokens(prompt);
      if (tokens === null) return null;
      return { input: tokens, output: 0 };
    },
    [config],
  );

  const sendPrompt = useCallback(
    async (userText: string) => {
      const trimmed = userText.trim();
      if (!trimmed || isStreaming) return;
      if (unconfigured) return;
      // If a hydration is in flight (page reload), wait for it before
      // letting the agent see the registry — otherwise its first ListInputs
      // / RunSQL would race the rehydrate.
      await hydrateOnce();

      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: trimmed,
        createdAt: Date.now(),
      };
      const assistantMsg: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: '',
        createdAt: Date.now(),
      };

      // For assistant turns prefer `historyContent` (model-replay format with
      // proper `<|tool_call>` tokens) over `content` (UI-format text with
      // `→/←` markers). Without this swap, local-Gemma sees its own past
      // tool calls as plain text and starts imitating them — producing
      // hallucinated tool calls that never execute.
      // Compaction markers stay in the UI history (rendered as a foldable
      // "Compacted" row) but get lifted out of the conversation: their
      // summary is appended to the system prompt as instructional context,
      // not replayed as a user/assistant turn.
      const compactionContext = buildCompactionContext(history.messages);
      const priorTurns = mapMessagesForLLM(history.messages);
      const requestMessages: StreamChatMessage[] = [
        { role: 'system', content: AGENT_SYSTEM_PROMPT + compactionContext },
        ...priorTurns,
        { role: 'user', content: trimmed },
      ];

      appendMessage(userMsg);
      appendMessage(assistantMsg);

      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      executionPanelStore.setLlmActive(true);
      wasAtBottomRef.current = true;

      await streamChat({
        config,
        messages: requestMessages,
        tools: AGENT_TOOLS,
        signal: controller.signal,
        onToken: (delta) => updateLastAssistant(delta),
        onHistoryDelta: (delta) => appendLastAssistantHistory(delta),
        onUsage: (usage) => tokenUsageStore.setTokenUsage(usage),
        onDone: () => {
          flush();
          setIsStreaming(false);
          executionPanelStore.setLlmActive(false);
          abortRef.current = null;
          // Defer to the next tick so React has committed the final
          // history updates from the streaming callbacks; otherwise
          // historyRef.current can lag the just-streamed assistant turn.
          setTimeout(() => {
            void maybeAutoCompact({
              config,
              messages: historyRef.current,
              replaceMessages,
              flush,
              setHighlightId: setHighlightCompactedId,
              scrollToTop,
              signal: controller.signal,
              estimatePostCompactionUsage,
            });
          }, 0);
        },
        onError: (err) => {
          setLastAssistantContent(err.message || 'Request failed.', true);
          flush();
          setIsStreaming(false);
          executionPanelStore.setLlmActive(false);
          abortRef.current = null;
        },
      });
    },
    [
      appendLastAssistantHistory,
      appendMessage,
      config,
      estimatePostCompactionUsage,
      flush,
      history.messages,
      isStreaming,
      replaceMessages,
      scrollToTop,
      setLastAssistantContent,
      unconfigured,
      updateLastAssistant,
    ],
  );

  const startOrAdvance = useCallback(
    (mode: 'running' | 'paused') => {
      if (debugger_.pending) {
        if (mode === 'running') toolDebugger.play();
        else toolDebugger.step();
        return;
      }
      if (isStreaming || input.trim().length === 0 || unconfigured) return;
      toolDebugger.setMode(mode);
      const text = input;
      setInput('');
      requestAnimationFrame(() => autoGrow());
      void sendPrompt(text);
    },
    [autoGrow, debugger_.pending, input, isStreaming, sendPrompt, unconfigured],
  );

  const onPlay = useCallback(() => startOrAdvance('running'), [startOrAdvance]);
  const onStep = useCallback(() => startOrAdvance('paused'), [startOrAdvance]);
  const onPause = useCallback(() => {
    toolDebugger.pause();
  }, []);

  const compacting = panelSnap.llm.compacting;

  const onCompact = useCallback(async () => {
    if (isStreaming || compacting || unconfigured) return;
    const slice = buildCompactionSlice(history.messages);
    if (!slice) return;
    await runCompaction({
      config,
      toCompact: slice.toCompact,
      recent: slice.recent,
      replaceMessages,
      flush,
      setHighlightId: setHighlightCompactedId,
      scrollToTop,
      estimatePostCompactionUsage,
    });
  }, [
    compacting,
    config,
    estimatePostCompactionUsage,
    flush,
    history.messages,
    isStreaming,
    replaceMessages,
    scrollToTop,
    unconfigured,
  ]);

  const compactionPending = debugger_.pending?.toolName === COMPACTION_TOOL_NAME;
  const submitDisabled =
    unconfigured ||
    restoring ||
    compactionPending ||
    (!debugger_.pending && (isStreaming || input.trim().length === 0));

  const onRetry = useCallback(
    (assistantId: string) => {
      const idx = history.messages.findIndex((m) => m.id === assistantId);
      if (idx < 1) return;
      const userTurn = history.messages[idx - 1];
      if (userTurn.role !== 'user') return;
      // Drop the failed assistant turn (and the user turn — sendPrompt re-adds it).
      const trimmed = history.messages.slice(0, idx - 1);
      replaceMessages(trimmed);
      void sendPrompt(userTurn.content);
    },
    [history.messages, replaceMessages, sendPrompt],
  );

  const onNewChat = useCallback(() => {
    if (isStreaming) abortRef.current?.abort();
    toolDebugger.reset();
    executionPanelStore.clearPanelAndPersistence();
    tokenUsageStore.setTokenUsage(null);
    clear();
    void clearAllInputs().catch((err) => {
      console.warn('onNewChat: clearAllInputs failed:', err);
    });
  }, [clear, isStreaming]);

  const messages = history.messages;
  const hasMessages = messages.length > 0;

  const pressureLevel: PressureLevel = useMemo(() => {
    if (!config.activeEndpoint) return 'ok';
    const used = tokenUsage ? tokenUsage.input + tokenUsage.output : 0;
    return getPressureLevel(used, getContextWindowForEndpoint(config.activeEndpoint));
  }, [config.activeEndpoint, tokenUsage]);
  const pressureSuffix =
    pressureLevel === 'ok' ? '' : ' chat-pressure-' + pressureLevel;
  const compactDisabled =
    isStreaming ||
    compacting ||
    unconfigured ||
    messages.filter((m) => m.role === 'user' && m.kind !== 'compaction').length < 2;

  return (
    <>
      <aside
        className="chat-sidebar"
        data-open={isOpenMobile ? 'true' : 'false'}
        aria-label="Chat"
      >
        <div
          className="chat-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat sidebar"
          aria-valuemin={CHAT_MIN_WIDTH}
          aria-valuemax={CHAT_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={onResizeHandlePointerDown}
          onKeyDown={onResizeHandleKeyDown}
        />
        <header className="chat-header">
          <div className="chat-title">
            {config.activeEndpoint && config.models[config.activeEndpoint] ? (
              <>
                <span className="chat-model">{config.models[config.activeEndpoint]}</span>
                {isLocalGemmaEndpoint(config.activeEndpoint) && (
                  <label className="chat-thinking-toggle">
                    <input
                      type="checkbox"
                      checked={config.thinkingEnabled?.[LOCAL_GEMMA_ENDPOINT] ?? false}
                      onChange={(e) =>
                        setThinkingEnabled(LOCAL_GEMMA_ENDPOINT, e.target.checked)
                      }
                      aria-label="Enable Gemma thinking mode"
                    />
                    Thinking
                  </label>
                )}
              </>
            ) : (
              <span className="chat-model chat-model-empty">No model</span>
            )}
          </div>
          <div className="chat-header-actions">
            <PressureIndicator />
            {config.activeEndpoint && config.models[config.activeEndpoint] && (
              <span className={'chat-tokens' + pressureSuffix}>
                {formatTokenCount(tokenUsage ? tokenUsage.input + tokenUsage.output : 0)}
                {' / '}
                {formatTokenCount(getContextWindowForEndpoint(config.activeEndpoint))}
              </span>
            )}
            <button
              type="button"
              className="chat-iconbtn"
              onClick={onNewChat}
              title="New chat"
              aria-label="New chat"
              disabled={!hasMessages && !isStreaming}
            >
              <ChatAddOnIcon size={18} />
            </button>
            <button
              type="button"
              className="chat-iconbtn chat-mobile-close"
              onClick={() => setIsOpenMobile(false)}
              title="Close chat"
              aria-label="Close chat"
            >
              <CloseIcon size={16} />
            </button>
          </div>
        </header>

        <div className="chat-list" ref={listRef} role="log" aria-live="polite">
          {!hasMessages && (
            <div className="chat-empty">
              Ask anything. Responses stream from the LLM you configured in Settings.
            </div>
          )}
          {messages.map((m, i) => {
            if (m.kind === 'compaction') {
              return (
                <CollapsibleCompacted
                  key={m.id}
                  summary={m.content}
                  highlight={m.id === highlightCompactedId}
                />
              );
            }
            const isLast = i === messages.length - 1;
            const isPending =
              isStreaming && isLast && m.role === 'assistant' && m.content === '';
            return (
              <ChatMessageRow
                key={m.id}
                message={m}
                isPending={isPending}
                onRetry={onRetry}
              />
            );
          })}
        </div>

        {unconfigured && (
          <div className="chat-banner">
            Configure an LLM provider in Settings to start chatting.
          </div>
        )}

        <div className="chat-toolbar">
          <div className="chat-toolbar-group">
            <button
              type="button"
              className={
                'chat-iconbtn' +
                (debugger_.pending
                  ? stepShaking
                    ? ' chat-iconbtn--shake'
                    : ' chat-iconbtn--attention'
                  : '')
              }
              onClick={onStep}
              disabled={submitDisabled}
              title="Step"
              aria-label="Step"
            >
              <StepIcon size={16} />
            </button>
            <button
              type="button"
              className="chat-iconbtn"
              onClick={onPlay}
              disabled={submitDisabled}
              title="Play"
              aria-label="Play"
            >
              <PlayIcon size={16} />
            </button>
            <button
              type="button"
              className="chat-iconbtn"
              onClick={onPause}
              disabled={
                !(isStreaming && debugger_.mode === 'running' && !debugger_.pending)
              }
              title="Pause"
              aria-label="Pause"
            >
              <PauseIcon size={16} />
            </button>
            <button
              type="button"
              className={'chat-iconbtn' + pressureSuffix}
              onClick={() => void onCompact()}
              disabled={compactDisabled}
              title="Compact conversation"
              aria-label="Compact conversation"
            >
              <CompressIcon size={16} />
            </button>
          </div>
          {debugger_.pending ? (
            <div className="chat-status-pill" role="status" aria-live="polite">
              <span className="chat-status-dot" aria-hidden="true" />
              Paused at {debugger_.pending.toolName}
            </div>
          ) : (
            <Throbber />
          )}
        </div>

        {pressureLevel !== 'ok' && (
          <div
            className={'chat-pressure-hint chat-pressure-hint--' + pressureLevel}
            role="status"
            aria-live="polite"
          >
            {pressureLevel === 'danger'
              ? 'Degraded performance. Compaction is necessary.'
              : 'Compaction is recommended.'}
          </div>
        )}

        <div className="chat-composer">
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow();
            }}
            placeholder={
              unconfigured ? 'Configure a provider in Settings…' : 'Message…'
            }
            rows={3}
            disabled={unconfigured}
            aria-label="Chat message"
          />
        </div>
      </aside>

      <button
        type="button"
        className="btn btn-primary chat-fab"
        onClick={() => setIsOpenMobile(true)}
        aria-label="Open chat"
      >
        Chat
      </button>
    </>
  );
}
