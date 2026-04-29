import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { EditorView } from '@codemirror/view';

interface CodeViewProps {
  code: string;
  language: 'python' | 'sql';
}

export default function CodeView({ code, language }: CodeViewProps) {
  const extensions = useMemo(
    () => [language === 'python' ? python() : sql(), EditorView.lineWrapping],
    [language],
  );

  return (
    <CodeMirror
      value={code}
      extensions={extensions}
      readOnly
      editable={false}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        dropCursor: false,
      }}
      theme="light"
      height="100%"
      style={{ height: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}
    />
  );
}
