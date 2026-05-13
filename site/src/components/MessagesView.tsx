import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../types/chat';
import {
  parseAssistantContent,
  type AssistantSegment,
} from '../lib/parseAssistantContent';
import {
  parseSourcecodeUrl,
  SOURCECODE_URL_PREFIX,
} from '../lib/sourcecode/parseSourcecodeUrl';
import { showSourcecodeRange } from '../lib/sourcecode/showRange';
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
} from './Icons';

const MARKDOWN_PLUGINS = [remarkGfm];

// react-markdown's default urlTransform sanitises non-standard schemes (it
// only allows http/https/mailto/tel/etc.), which would silently drop our
// `@sourcecode:` hrefs before the `a` component sees them. Whitelist the
// scheme here.
function markdownUrlTransform(url: string): string {
  return url.startsWith(SOURCECODE_URL_PREFIX) ? url : defaultUrlTransform(url);
}

function openSourcecodeFromHref(href: string): void {
  const parsed = parseSourcecodeUrl(href);
  if (!parsed) return;
  showSourcecodeRange({
    path: parsed.path,
    startLine: parsed.startLine ?? 1,
    endLine: parsed.endLine,
  });
}

const MARKDOWN_COMPONENTS = {
  a: ({
    href,
    children,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    if (typeof href === 'string' && href.startsWith(SOURCECODE_URL_PREFIX)) {
      return (
        <button
          type="button"
          className="chat-sourcecode-link"
          title={href}
          onClick={(e) => {
            e.preventDefault();
            openSourcecodeFromHref(href);
          }}
        >
          {children}
        </button>
      );
    }
    return (
      <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
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

export function CollapsibleElidedReasoning() {
  const [expanded, setExpanded] = useState(false);
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
        <span className="chat-tool-name">Earlier reasoning elided</span>
      </button>
      {expanded && (
        <div className="chat-tool-body">
          <div className="chat-elided-reasoning-body">
            Earlier reasoning and tool details from this turn were elided
            during compaction to free up context. The final tool call and
            answer are preserved above.
          </div>
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
              urlTransform={markdownUrlTransform}
            >
              {seg.text}
            </ReactMarkdown>
          );
        }
        if (seg.kind === 'thinking') {
          return <CollapsibleThinking key={i} text={seg.text} done={seg.done} />;
        }
        if (seg.kind === 'compacted') {
          return <CollapsibleElidedReasoning key={i} />;
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

function renderMessageBody(
  m: ChatMessage,
  isPending: boolean,
  onContinue?: () => void,
) {
  if (isPending) return <span className="chat-typing">…</span>;
  if (m.role === 'assistant' && !m.error) {
    return (
      <>
        <AssistantBody content={m.content} />
        {m.maxIterationsReached && onContinue && (
          <button
            type="button"
            className="chat-continue-btn"
            onClick={onContinue}
          >
            Continue
          </button>
        )}
      </>
    );
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
  onContinue?: () => void;
}

export const ChatMessageRow = memo(function ChatMessageRow({
  message,
  isPending,
  onRetry,
  onContinue,
}: ChatMessageRowProps) {
  const m = message;
  const showCopy = !isPending && !!m.content;
  return (
    <div className={`chat-row chat-row-${m.role}`}>
      <div className={'chat-msg chat-msg-' + (m.error ? 'error' : m.role)}>
        {showCopy && <CopyBubbleButton message={m} />}
        {renderMessageBody(m, isPending, onContinue)}
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
  /** Invoked when the user clicks the "Continue" button on an assistant
   * bubble that stopped at the tool-iteration limit. */
  onContinue?: () => void;
  emptyState?: React.ReactNode;
  /** Forwarded ref so the parent can scroll-pin etc. */
  listRef?: React.Ref<HTMLDivElement>;
  /** When provided, rendered as a collapsible full-width "System Prompt" bubble at the top of the list. */
  systemPrompt?: string;
  /**
   * Optional tour cutout id applied as `data-tour-id` on the list root. Only the
   * primary chat conversation should set this — secondary instances (e.g. the
   * sub-agent transcript) must omit it so spotlight cutouts don't union across
   * unrelated scrollable lists.
   */
  tourId?: string;
}

export default function MessagesView({
  messages,
  pendingAssistantId,
  highlightCompactedId,
  onRetry,
  onContinue,
  emptyState,
  listRef,
  systemPrompt,
  tourId,
}: MessagesViewProps) {
  const hasMessages = messages.length > 0;
  return (
    <div
      className="chat-list"
      ref={listRef}
      role="log"
      aria-live="polite"
      data-tour-id={tourId}
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
            onContinue={onContinue}
          />
        );
      })}
    </div>
  );
}
