import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../types/chat';
import {
  parseAssistantContent,
  type AssistantSegment,
} from '../lib/parseAssistantContent';
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
} from './Icons';

const MARKDOWN_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
};

export function CollapsibleThinking({ text, done }: { text: string; done: boolean }) {
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

export function CollapsibleToolCall({
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

export function CollapsibleSystemPrompt({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="chat-system-prompt">
      <button
        type="button"
        className="chat-tool-summary"
        data-expanded={expanded ? 'true' : 'false'}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <ChevronRightIcon size={14} />
        <span className="chat-tool-name">System Prompt</span>
      </button>
      {expanded && (
        <div className="chat-tool-body">
          <pre>
            <code>{text}</code>
          </pre>
        </div>
      )}
    </div>
  );
}

export function CollapsibleCompacted({
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

function getCopyText(m: ChatMessage): string {
  if (m.role === 'assistant' && !m.error) {
    return parseAssistantContent(m.content)
      .filter((seg) => seg.kind === 'text')
      .map((seg) => (seg as { kind: 'text'; text: string }).text)
      .join('')
      .trim();
  }
  return m.content;
}

function CopyBubbleButton({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    const text = getCopyText(message);
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [message]);
  return (
    <button
      type="button"
      className="chat-msg-copy"
      onClick={onCopy}
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

interface ChatMessageRowProps {
  message: ChatMessage;
  isPending: boolean;
  onRetry?: (id: string) => void;
}

export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  isPending,
  onRetry,
}: ChatMessageRowProps) {
  const m = message;
  const showCopy = !isPending && !!m.content;
  return (
    <div className={`chat-row chat-row-${m.role}`}>
      <div className={'chat-msg chat-msg-' + (m.error ? 'error' : m.role)}>
        {showCopy && <CopyBubbleButton message={m} />}
        {renderMessageBody(m, isPending)}
      </div>
      {m.error && onRetry && (
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

export interface MessagesViewProps {
  messages: ChatMessage[];
  /** id of the last assistant message that's still streaming (so it renders the typing indicator). */
  pendingAssistantId?: string | null;
  highlightCompactedId?: string | null;
  onRetry?: (id: string) => void;
  emptyState?: React.ReactNode;
  /** Forwarded ref so the parent can scroll-pin etc. */
  listRef?: React.Ref<HTMLDivElement>;
  /** When provided, rendered as a collapsible full-width "System Prompt" bubble at the top of the list. */
  systemPrompt?: string;
}

export default function MessagesView({
  messages,
  pendingAssistantId,
  highlightCompactedId,
  onRetry,
  emptyState,
  listRef,
  systemPrompt,
}: MessagesViewProps) {
  const hasMessages = messages.length > 0;
  return (
    <div
      className="chat-list"
      ref={listRef}
      role="log"
      aria-live="polite"
      data-tour-id="chat.conversation"
    >
      {systemPrompt && <CollapsibleSystemPrompt text={systemPrompt} />}
      {!hasMessages && emptyState}
      {messages.map((m) => {
        if (m.kind === 'compaction') {
          return (
            <CollapsibleCompacted
              key={m.id}
              summary={m.content}
              highlight={m.id === highlightCompactedId}
            />
          );
        }
        const isPending =
          pendingAssistantId === m.id && m.role === 'assistant' && m.content === '';
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
  );
}
