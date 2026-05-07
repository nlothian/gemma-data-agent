import { useEffect, useMemo, useState } from 'react';
import CodeMirror, {
  Decoration,
  EditorView,
  StateField,
  type DecorationSet,
  type Extension,
} from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import type { OpenFileTarget } from './SourcecodeOverlay';
import { readSourceFile } from '../lib/sourcecode/readSource';

interface SourcecodeFileViewerProps {
  file: OpenFileTarget;
  onBack: () => void;
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    minHeight: 0,
    gap: '12px',
  } as const,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  } as const,
  backButton: {
    fontFamily: 'var(--font-sans)',
    fontWeight: 500,
    fontSize: '12px',
    color: 'var(--graphite)',
    background: 'var(--gel-white)',
    border: '1px solid var(--mist)',
    padding: '6px 10px',
    borderRadius: 'var(--r-8)',
    cursor: 'pointer',
    boxShadow: 'var(--el-1), var(--inner-gloss)',
  } as const,
  pathLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    color: 'var(--graphite)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
    textAlign: 'right' as const,
  } as const,
  content: {
    flex: 1,
    minHeight: 400,
    border: '1px solid var(--mist)',
    borderRadius: 'var(--r-12)',
    overflow: 'hidden',
    background: 'var(--white)',
    display: 'flex',
    flexDirection: 'column' as const,
  } as const,
  status: {
    fontFamily: 'var(--font-mono)',
    fontSize: '13px',
    color: 'var(--ink)',
    background: 'var(--gel-white)',
    padding: '16px',
  } as const,
  editorWrapper: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column' as const,
  } as const,
};

const HIGHLIGHT_STYLE = `.cm-sourcecode-match { background: var(--aqua-500); color: var(--white); border-radius: 2px; }`;

function computeAbsoluteOffset(text: string, line: number, col: number): number {
  // line is 1-based, col is 0-based
  let pos = 0;
  let lineCount = 1;
  while (lineCount < line && pos < text.length) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) break;
    pos = nl + 1;
    lineCount++;
  }
  return Math.min(text.length, pos + col);
}

/**
 * 1-based start of `line` and end-of-content of `endLine`. End offset is the
 * char before the next newline (or text.length if last line).
 */
function computeRangeOffsets(
  text: string,
  startLine: number,
  endLine: number,
): { start: number; end: number } {
  const start = computeAbsoluteOffset(text, startLine, 0);
  const endLineStart = computeAbsoluteOffset(text, endLine, 0);
  const nl = text.indexOf('\n', endLineStart);
  const end = nl === -1 ? text.length : nl;
  return { start, end: Math.max(start, end) };
}

function pickLanguageExtension(path: string): Extension[] {
  const lower = path.toLowerCase();
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx === -1) return [];
  const ext = lower.slice(dotIdx);
  switch (ext) {
    case '.ts':
    case '.tsx':
      return [javascript({ jsx: true, typescript: true })];
    case '.js':
    case '.mjs':
    case '.cjs':
    case '.jsx':
      return [javascript({ jsx: true })];
    case '.py':
      return [python()];
    case '.sql':
      return [sql()];
    case '.css':
      return [css()];
    case '.json':
      return [json()];
    case '.md':
    case '.mdx':
      return [markdown()];
    case '.html':
    case '.astro':
      return [html()];
    default:
      return [];
  }
}

const highlightMark = Decoration.mark({ class: 'cm-sourcecode-match' });

function makeMatchExtension(absStart: number, absEnd: number): Extension {
  return StateField.define<DecorationSet>({
    create(state) {
      const safeStart = Math.max(0, Math.min(state.doc.length, absStart));
      const safeEnd = Math.max(safeStart, Math.min(state.doc.length, absEnd));
      if (safeStart === safeEnd) return Decoration.none;
      return Decoration.set([highlightMark.range(safeStart, safeEnd)]);
    },
    update(deco) {
      return deco;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

export default function SourcecodeFileViewer({ file, onBack }: SourcecodeFileViewerProps): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);

    (async () => {
      try {
        const content = await readSourceFile(file.path);
        if (!cancelled) {
          setText(content);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file.path]);

  const langExt = useMemo(() => pickLanguageExtension(file.path), [file.path]);

  const absOffsets = useMemo(() => {
    if (text === null) return null;
    if (file.kind === 'range') {
      return computeRangeOffsets(text, file.startLine, file.endLine);
    }
    const start = computeAbsoluteOffset(text, file.line, file.matchStart);
    const end = computeAbsoluteOffset(text, file.line, file.matchEnd);
    return { start, end };
  }, [text, file]);

  const extensions = useMemo<Extension[]>(() => {
    if (absOffsets === null) return [];
    return [
      ...langExt,
      EditorView.lineWrapping,
      makeMatchExtension(absOffsets.start, absOffsets.end),
    ];
  }, [langExt, absOffsets]);

  return (
    <div style={styles.root}>
      <style>{HIGHLIGHT_STYLE}</style>
      <div style={styles.header}>
        <button
          type="button"
          style={styles.backButton}
          onClick={onBack}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--silver)';
            e.currentTarget.style.color = 'var(--ink)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--mist)';
            e.currentTarget.style.color = 'var(--graphite)';
          }}
        >
          ← Back to results
        </button>
        <div style={styles.pathLabel}>
          {file.kind === 'range'
            ? `${file.path}:${file.startLine}${file.endLine !== file.startLine ? `-${file.endLine}` : ''}`
            : `${file.path}:${file.line}`}
        </div>
      </div>
      <div style={styles.content}>
        {error !== null ? (
          <div style={styles.status}>Could not read file: {error}</div>
        ) : text === null ? (
          <div style={styles.status}>Loading…</div>
        ) : (
          <div style={styles.editorWrapper}>
            <CodeMirror
              value={text}
              editable={false}
              readOnly={true}
              extensions={extensions}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: false,
                highlightSelectionMatches: false,
              }}
              theme="light"
              height="100%"
              style={{ height: '100%', flex: 1, minHeight: 0 }}
              onCreateEditor={(view) => {
                if (absOffsets === null) return;
                const docLen = view.state.doc.length;
                const safeStart = Math.max(0, Math.min(docLen, absOffsets.start));
                const safeEnd = Math.max(safeStart, Math.min(docLen, absOffsets.end));
                view.dispatch({
                  effects: EditorView.scrollIntoView(safeStart, { y: 'center' }),
                  selection: { anchor: safeStart, head: safeEnd },
                });
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
