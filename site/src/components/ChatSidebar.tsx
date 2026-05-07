import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import useLLMConfig from '../hooks/useLLMConfig';
import useChatHistory from '../hooks/useChatHistory';
import useChatSidebarWidth, {
  MIN_WIDTH as CHAT_MIN_WIDTH,
  MAX_WIDTH as CHAT_MAX_WIDTH,
} from '../hooks/useChatSidebarWidth';
import { useAttentionShake } from '../hooks/useAttentionShake';
import { streamChat, type StreamChatMessage } from '../lib/streamChat';
import { generateId } from '../lib/browser';
import {
  buildAgentSystemPrompt,
  buildAgentTools,
} from '../lib/agentTools';
import * as toolDebugger from '../lib/toolDebugger';
import * as executionPanelStore from '../lib/executionPanelStore';
import * as agentFeatures from '../lib/agentFeaturesStore';
import * as tokenUsageStore from '../lib/tokenUsageStore';
import { restoreRegistryFromIndexedDB } from '../lib/duckdb';
import {
  getContextWindowForEndpoint,
  formatTokenCount,
  getPressureLevel,
  type PressureLevel,
} from '../lib/contextWindow';
import {
  buildCompactionContext,
  buildCompactionSlice,
  compactNow,
  COMPACTION_TOOL_NAME,
  mapMessagesForLLM,
  maybeAutoCompact,
  runCompaction,
} from '../lib/autoCompaction';
import { renderConversationForGemma } from '../lib/localLlm/toolPrompt';
import { isInputTooLongError, sizeInTokens } from '../lib/localLlm/llmService';
import * as subAgentStore from '../lib/subAgents/store';
import { setSubAgentContext } from '../lib/subAgents/context';
import { registerChatBridge } from '../lib/tour/bridge';
import type { TokenUsage } from '../lib/tokenUsageStore';
import type { ChatMessage } from '../types/chat';
import { isLocalGemmaEndpoint, LOCAL_GEMMA_ENDPOINT } from '../types/llm';
import {
  ChatAddOnIcon,
  CloseIcon,
  CompressIcon,
  PlayIcon,
  StepIcon,
  StopIcon,
} from './Icons';
import ModelSelector from './ModelSelector';
import Throbber from './Throbber';
import PressureIndicator from './PressureIndicator';
import MessagesView from './MessagesView';

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

export default function ChatSidebar() {
  const { config, ready: cfgReady } = useLLMConfig();
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
  const features = useSyncExternalStore(
    agentFeatures.subscribe,
    agentFeatures.getSnapshot,
    agentFeatures.getServerSnapshot,
  );
  // The bridge stays registered for the lifetime of ChatSidebar; methods that
  // close over frequently-changing state (like `onNewChat`, which depends on
  // `isStreaming`) are routed through a ref so we don't re-register the bridge
  // on every stream tick. ModelSelector owns `setModelMenuOpen` and the
  // switcher's `request` — it hands them back through these refs on mount.
  const newChatRef = useRef<() => void>(() => {});
  const setModelMenuOpenRef = useRef<(open: boolean) => void>(() => {});
  const requestModelRef = useRef<(id: string) => void>(() => {});
  const handleModelMenuSetterReady = useCallback(
    (setter: (open: boolean) => void) => {
      setModelMenuOpenRef.current = setter;
    },
    [],
  );
  const handleRequestModelReady = useCallback((fn: (id: string) => void) => {
    requestModelRef.current = fn;
  }, []);
  useEffect(
    () =>
      registerChatBridge({
        setModelMenuOpen: (open) => setModelMenuOpenRef.current(open),
        setInput,
        requestModel: (id) => requestModelRef.current(id),
        newChat: () => newChatRef.current(),
      }),
    [],
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
  const compactionPending =
    debugger_.pending?.toolName === COMPACTION_TOOL_NAME;
  const stepShaking = useAttentionShake(
    Boolean(debugger_.pending) && !compactionPending,
  );
  const compactShaking = useAttentionShake(compactionPending);
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
  // back to the next response's usage event. Safe to call `sizeInTokens` here
  // because compaction has already resolved (no MediaPipe decode in flight).
  const estimatePostCompactionUsage = useCallback(
    (msgs: ChatMessage[]): TokenUsage | null => {
      if (!isLocalGemmaEndpoint(config.activeEndpoint)) return null;
      const thinkingEnabled =
        config.thinkingEnabled?.[LOCAL_GEMMA_ENDPOINT] ?? false;
      const prompt = renderConversationForGemma(
        buildAgentSystemPrompt(features) + buildCompactionContext(msgs),
        mapMessagesForLLM(msgs),
        buildAgentTools(features),
        thinkingEnabled,
      );
      const tokens = sizeInTokens(prompt);
      if (tokens === null) return null;
      return { input: tokens, output: 0 };
    },
    [config, features],
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
        {
          role: 'system',
          content: buildAgentSystemPrompt(features) + compactionContext,
        },
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

      // Make the parent-thread context available to any RunSubAgent tool
      // call the LLM emits during this stream.
      setSubAgentContext({
        config,
        features,
        parentMessages: history.messages,
      });

      await streamChat({
        config,
        messages: requestMessages,
        tools: buildAgentTools(features),
        signal: controller.signal,
        onToken: (delta) => updateLastAssistant(delta),
        onHistoryDelta: (delta) => appendLastAssistantHistory(delta),
        onUsage: (usage) => tokenUsageStore.setTokenUsage(usage),
        onMidStreamCompaction: ({ summary }) => {
          // Insert the marker before the in-flight assistant turn (the tail
          // of history while streaming) so it shows up in the same position
          // as a normal post-turn compaction.
          const current = historyRef.current;
          const tail = current[current.length - 1];
          const isStreamingAssistant =
            tail && tail.role === 'assistant' && !tail.error;
          const marker: ChatMessage = {
            id: generateId(),
            role: 'user',
            kind: 'compaction',
            content: summary,
            createdAt: Date.now(),
          };
          const next = isStreamingAssistant
            ? [...current.slice(0, -1), marker, tail]
            : [...current, marker];
          replaceMessages(next);
          flush();
          setHighlightCompactedId(marker.id);
          setTimeout(() => setHighlightCompactedId(null), 5000);
        },
        onDone: () => {
          flush();
          setIsStreaming(false);
          executionPanelStore.setLlmActive(false);
          executionPanelStore.setLlmPreparingToolCall(null);
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
          setIsStreaming(false);
          executionPanelStore.setLlmActive(false);
          executionPanelStore.setLlmPreparingToolCall(null);
          abortRef.current = null;

          if (isInputTooLongError(err)) {
            // The provider rejected the request as too long. Drop the failed
            // user+assistant pair, run the compaction flow (gated through
            // Step in paused mode, immediate in running mode), then retry
            // the original prompt against the smaller context.
            const truncated = historyRef.current.slice(0, -2);
            const slice = buildCompactionSlice(truncated);
            if (slice) {
              replaceMessages(truncated);
              flush();
              void (async () => {
                try {
                  const ok = await compactNow({
                    config,
                    toCompact: slice.toCompact,
                    recent: slice.recent,
                    replaceMessages,
                    flush,
                    setHighlightId: setHighlightCompactedId,
                    scrollToTop,
                    estimatePostCompactionUsage,
                    signal: controller.signal,
                  });
                  if (ok) void sendPrompt(trimmed);
                } catch (compactErr) {
                  console.warn(
                    'Auto-compaction after input-too-long failed:',
                    compactErr,
                  );
                }
              })();
              return;
            }
          }

          setLastAssistantContent(err.message || 'Request failed.', true);
          flush();
        },
      });
    },
    [
      appendLastAssistantHistory,
      appendMessage,
      config,
      estimatePostCompactionUsage,
      features,
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
  const onStop = useCallback(() => {
    abortRef.current?.abort();
    // reset() flips the debugger to paused (the previous Pause behaviour)
    // and also aborts any pending tool gate so the agent loop unwinds
    // cleanly instead of staying wedged at a Step prompt.
    toolDebugger.reset();
  }, []);

  const compacting = panelSnap.llm.compacting;

  const onCompact = useCallback(async () => {
    if (isStreaming || compacting || unconfigured) return;
    const slice = buildCompactionSlice(history.messages);
    if (!slice) return;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runCompaction({
        config,
        toCompact: slice.toCompact,
        recent: slice.recent,
        replaceMessages,
        flush,
        setHighlightId: setHighlightCompactedId,
        scrollToTop,
        estimatePostCompactionUsage,
        signal: controller.signal,
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
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
    tokenUsageStore.setTokenUsage(null);
    subAgentStore.clearAll();
    executionPanelStore.clearNonDataPanes();
    clear();
  }, [clear, isStreaming]);
  newChatRef.current = onNewChat;

  const messages = history.messages;
  const hasMessages = messages.length > 0;

  // Mirror the system prompt that sendPrompt assembles, so the user can see
  // exactly what the model will receive on the next turn.
  const systemPrompt = useMemo(
    () => buildAgentSystemPrompt(features) + buildCompactionContext(messages),
    [features, messages],
  );

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
            <ModelSelector
              onModelMenuOpenChange={handleModelMenuSetterReady}
              onRequestModelReady={handleRequestModelReady}
            />
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

        <MessagesView
          listRef={listRef}
          messages={messages}
          systemPrompt={systemPrompt}
          tourId="chat.conversation"
          pendingAssistantId={
            isStreaming && messages.length > 0
              ? messages[messages.length - 1].id
              : null
          }
          highlightCompactedId={highlightCompactedId}
          onRetry={onRetry}
          emptyState={
            <div className="chat-empty">
              Ask anything. Responses stream from the LLM you configured in Settings.
            </div>
          }
        />

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
              data-tour-id="chat.stepButton"
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
              data-tour-id="chat.playButton"
            >
              <PlayIcon size={16} />
            </button>
            <button
              type="button"
              className="chat-iconbtn"
              onClick={onStop}
              disabled={!(isStreaming || compacting)}
              title="Stop"
              aria-label="Stop"
            >
              <StopIcon size={16} />
            </button>
            <button
              type="button"
              className={
                'chat-iconbtn' +
                pressureSuffix +
                (compactionPending
                  ? compactShaking
                    ? ' chat-iconbtn--shake'
                    : ' chat-iconbtn--attention'
                  : '')
              }
              onClick={() => {
                if (compactionPending) toolDebugger.step();
                else void onCompact();
              }}
              disabled={compactionPending ? false : compactDisabled}
              title={compactionPending ? 'Run compaction' : 'Compact conversation'}
              aria-label={compactionPending ? 'Run compaction' : 'Compact conversation'}
              data-tour-id="chat.compactionRunButton"
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
            data-tour-id="chat.messageEntry"
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
