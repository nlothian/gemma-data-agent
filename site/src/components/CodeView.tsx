import { useEffect, useMemo, useRef } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { javascript } from '@codemirror/lang-javascript';
import { EditorView, placeholder as placeholderExt } from '@codemirror/view';

interface CodeViewProps {
  code: string;
  language: 'python' | 'sql' | 'tsx' | 'plain';
  editable?: boolean;
  onChange?: (value: string) => void;
  placeholder?: string;
}

export default function CodeView({
  code,
  language,
  editable = false,
  onChange,
  placeholder,
}: CodeViewProps) {
  const extensions = useMemo(() => {
    const base =
      language === 'plain'
        ? [EditorView.lineWrapping]
        : language === 'python'
          ? [python(), EditorView.lineWrapping]
          : language === 'sql'
            ? [sql(), EditorView.lineWrapping]
            : [javascript({ jsx: true, typescript: true }), EditorView.lineWrapping];
    if (placeholder) base.push(placeholderExt(placeholder));
    return base;
  }, [language, placeholder]);

  // Auto-scroll to the end whenever the value is being appended to (i.e. the
  // model is streaming code in). We compare against the previous value: if
  // the new content extends the old as a prefix and grew, it's a streaming
  // append, and we keep the editor scrolled to the new tail. User edits in
  // the middle of the doc don't satisfy the prefix check, so the cursor
  // isn't yanked while typing.
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const prevCodeRef = useRef(code);
  useEffect(() => {
    const prev = prevCodeRef.current;
    prevCodeRef.current = code;
    if (code.length <= prev.length || !code.startsWith(prev)) return;
    const view = editorRef.current?.view;
    if (!view) return;
    view.dispatch({
      effects: EditorView.scrollIntoView(view.state.doc.length, { y: 'end' }),
    });
  }, [code]);

  return (
    <CodeMirror
      ref={editorRef}
      value={code}
      extensions={extensions}
      readOnly={!editable}
      editable={editable}
      onChange={editable ? onChange : undefined}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: editable,
        highlightActiveLineGutter: editable,
        dropCursor: editable,
      }}
      theme="light"
      height="100%"
      style={{ height: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}
    />
  );
}

export function languageFromPath(path: string): 'python' | 'sql' | 'tsx' | 'plain' {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'py') return 'python';
  if (ext === 'sql') return 'sql';
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return 'tsx';
  return 'plain';
}
