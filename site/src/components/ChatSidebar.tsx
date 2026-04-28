import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import useLLMConfig from '../hooks/useLLMConfig';
import useChatHistory from '../hooks/useChatHistory';
import { streamChat, type StreamChatMessage } from '../lib/streamChat';
import { generateId } from '../lib/browser';
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS } from '../lib/agentTools';
import type { ChatMessage } from '../types/chat';
import { CloseIcon, PlusIcon, SendIcon, StopIcon } from './Icons';

export default function ChatSidebar() {
  const { config, ready: cfgReady } = useLLMConfig();
  const {
    history,
    appendMessage,
    updateLastAssistant,
    setLastAssistantContent,
    replaceMessages,
    clear,
    flush,
  } = useChatHistory();

  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isOpenMobile, setIsOpenMobile] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const wasAtBottomRef = useRef(true);

  const unconfigured = useMemo(() => {
    if (!cfgReady) return false;
    const ep = config.activeEndpoint;
    if (!ep) return true;
    if (!config.apiKeys[ep]) return true;
    if (!config.models[ep]) return true;
    return false;
  }, [cfgReady, config]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
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

  const autoGrow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, []);

  const sendPrompt = useCallback(
    async (userText: string) => {
      const trimmed = userText.trim();
      if (!trimmed || isStreaming) return;
      if (unconfigured) return;

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

      // Build the request payload from prior history + new user turn.
      const priorTurns: StreamChatMessage[] = history.messages
        .filter((m) => !m.error && m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));
      const requestMessages: StreamChatMessage[] = [
        { role: 'system', content: AGENT_SYSTEM_PROMPT },
        ...priorTurns,
        { role: 'user', content: trimmed },
      ];

      appendMessage(userMsg);
      appendMessage(assistantMsg);

      const controller = new AbortController();
      abortRef.current = controller;
      setIsStreaming(true);
      wasAtBottomRef.current = true;

      await streamChat({
        config,
        messages: requestMessages,
        tools: AGENT_TOOLS,
        signal: controller.signal,
        onToken: (delta) => updateLastAssistant(delta),
        onDone: () => {
          flush();
          setIsStreaming(false);
          abortRef.current = null;
        },
        onError: (err) => {
          setLastAssistantContent(err.message || 'Request failed.', true);
          flush();
          setIsStreaming(false);
          abortRef.current = null;
        },
      });
    },
    [
      appendMessage,
      config,
      flush,
      history.messages,
      isStreaming,
      setLastAssistantContent,
      unconfigured,
      updateLastAssistant,
    ],
  );

  const onSubmit = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const text = input;
      setInput('');
      // Reset textarea height after clearing.
      requestAnimationFrame(() => autoGrow());
      void sendPrompt(text);
    },
    [autoGrow, input, sendPrompt],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = input;
        setInput('');
        requestAnimationFrame(() => autoGrow());
        void sendPrompt(text);
      }
    },
    [autoGrow, input, sendPrompt],
  );

  const onStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
    clear();
  }, [clear, isStreaming]);

  const messages = history.messages;
  const hasMessages = messages.length > 0;

  return (
    <>
      <aside
        className="chat-sidebar"
        data-open={isOpenMobile ? 'true' : 'false'}
        aria-label="Chat"
      >
        <header className="chat-header">
          <div className="chat-title">
            Chat
            {config.activeEndpoint && config.models[config.activeEndpoint] ? (
              <span className="chat-model">{config.models[config.activeEndpoint]}</span>
            ) : null}
          </div>
          <div className="chat-header-actions">
            <button
              type="button"
              className="chat-iconbtn"
              onClick={onNewChat}
              title="New chat"
              aria-label="New chat"
              disabled={!hasMessages && !isStreaming}
            >
              <PlusIcon size={16} />
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
            const isLast = i === messages.length - 1;
            const isPending =
              isStreaming && isLast && m.role === 'assistant' && m.content === '';
            return (
              <div key={m.id} className={`chat-row chat-row-${m.role}`}>
                <div
                  className={
                    'chat-msg chat-msg-' + (m.error ? 'error' : m.role)
                  }
                >
                  {isPending ? <span className="chat-typing">…</span> : m.content}
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
          })}
        </div>

        {unconfigured && (
          <div className="chat-banner">
            Configure an LLM provider in Settings to start chatting.
          </div>
        )}

        <form className="chat-composer" onSubmit={onSubmit}>
          <textarea
            ref={taRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoGrow();
            }}
            onKeyDown={onKeyDown}
            placeholder={
              unconfigured ? 'Configure a provider in Settings…' : 'Message…'
            }
            rows={1}
            disabled={unconfigured}
            aria-label="Chat message"
          />
          {isStreaming ? (
            <button
              type="button"
              className="btn btn-secondary chat-send"
              onClick={onStop}
              aria-label="Stop"
              title="Stop"
            >
              <StopIcon size={14} />
            </button>
          ) : (
            <button
              type="submit"
              className="btn btn-primary chat-send"
              disabled={unconfigured || input.trim().length === 0}
              aria-label="Send"
              title="Send"
            >
              <SendIcon size={14} />
            </button>
          )}
        </form>
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
