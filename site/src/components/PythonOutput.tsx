import { useEffect, useState } from 'react';
import { MaximizeIcon, MinimizeIcon } from './Icons';

interface PythonOutputProps {
  stdout: string;
  stderr: string;
  errorMessage?: string;
  result?: string;
  status: 'idle' | 'pending' | 'running' | 'done' | 'error' | 'aborted';
  images: string[];
  codeFolded?: boolean;
  onToggleFold?: () => void;
}

type SubTab = 'output' | 'plot';

export default function PythonOutput({
  stdout,
  stderr,
  errorMessage,
  result,
  status,
  images,
  codeFolded = false,
  onToggleFold,
}: PythonOutputProps) {
  const empty = !stdout && !stderr && !errorMessage;
  const hasImages = images.length > 0;
  const [sub, setSub] = useState<SubTab>('output');

  useEffect(() => {
    if (status === 'pending') setSub('output');
  }, [status]);

  useEffect(() => {
    if (images.length > 0) setSub('plot');
  }, [images]);

  useEffect(() => {
    if (!hasImages && sub === 'plot') setSub('output');
  }, [hasImages, sub]);

  const showOutput = sub === 'output' || !hasImages;

  return (
    <div className="exec-output-wrap" data-tour-id="exec.pythonOutput">
      {hasImages && (
        <div className="exec-output-subtabs" role="tablist">
          <SubTabButton
            label="Output"
            active={sub === 'output'}
            onClick={() => setSub('output')}
          />
          <SubTabButton
            label={`Plot (${images.length})`}
            active={sub === 'plot'}
            onClick={() => setSub('plot')}
          />
          {sub === 'plot' && onToggleFold && (
            <button
              type="button"
              className="exec-expand-btn"
              onClick={onToggleFold}
              aria-pressed={codeFolded}
              aria-label={codeFolded ? 'Restore code panel' : 'Expand plot'}
              title={codeFolded ? 'Restore code panel' : 'Expand plot'}
            >
              {codeFolded ? <MinimizeIcon size={14} /> : <MaximizeIcon size={14} />}
              <span>{codeFolded ? 'Restore' : 'Expand'}</span>
            </button>
          )}
        </div>
      )}

      <div
        className="exec-output-pane exec-output-pane-text"
        hidden={!showOutput}
      >
        <pre className="exec-output">
          {empty ? (
            <span className="exec-output-placeholder">{placeholderFor(status)}</span>
          ) : (
            <>
              {stdout && <span>{stdout}</span>}
              {stderr && <span className="exec-stderr">{stderr}</span>}
              {errorMessage && <span className="exec-error">{errorMessage}</span>}
            </>
          )}
        </pre>
        {result && (
          <div className="exec-result-footer">
            <span className="exec-result-label">result:</span> {result}
          </div>
        )}
      </div>

      {hasImages && (
        <div
          className="exec-output-pane exec-output-pane-plot"
          hidden={sub !== 'plot'}
        >
          <div className="exec-plot-list">
            {images.map((url, idx) => (
              <img key={url} src={url} alt={`figure ${idx + 1}`} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface SubTabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function SubTabButton({ label, active, onClick }: SubTabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-active={active}
      className="exec-subtab"
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function placeholderFor(status: PythonOutputProps['status']): string {
  switch (status) {
    case 'pending':
      return 'Awaiting Step / Play to execute…';
    case 'running':
      return 'Running…';
    case 'aborted':
      return 'Aborted before execution.';
    case 'done':
      return '(no output)';
    case 'error':
      return '';
    default:
      return 'Run a Python tool call to see stdout / stderr here.';
  }
}
