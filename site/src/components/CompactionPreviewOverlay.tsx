import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRightIcon, CloseIcon } from './Icons';
import { serialiseConversation } from '../lib/compactConversation';
import compactionPromptText from '../prompts/compactionPrompt.md?raw';
import type { ChatMessage } from '../types/chat';

interface Props {
  messages: ChatMessage[];
  onClose: () => void;
}

export default function CompactionPreviewOverlay({ messages, onClose }: Props) {
  const [historyExpanded, setHistoryExpanded] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div
      className="compaction-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Compaction details"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="compaction-preview-card">
        <button
          type="button"
          className="compaction-preview-close"
          onClick={onClose}
          aria-label="Close"
        >
          <CloseIcon size={18} />
        </button>
        <h2 className="compaction-preview-title">Compaction details</h2>

        <section className="compaction-preview-section">
          <h3>System prompt</h3>
          <pre className="compaction-preview-pre">{compactionPromptText}</pre>
        </section>

        <section className="compaction-preview-section">
          <button
            type="button"
            className="chat-tool-summary compaction-preview-fold"
            data-expanded={historyExpanded ? 'true' : 'false'}
            onClick={() => setHistoryExpanded((v) => !v)}
            aria-expanded={historyExpanded}
          >
            <ChevronRightIcon size={14} />
            <span>Conversation to compact ({messages.length} messages)</span>
          </button>
          {historyExpanded && (
            <pre className="compaction-preview-pre">
              {serialiseConversation(messages)}
            </pre>
          )}
        </section>
      </div>
    </div>,
    document.body,
  );
}
