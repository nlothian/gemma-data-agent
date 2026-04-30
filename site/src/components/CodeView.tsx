import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { EditorView, placeholder as placeholderExt } from '@codemirror/view';

interface CodeViewProps {
  code: string;
  language: 'python' | 'sql';
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
    const base = [
      language === 'python' ? python() : sql(),
      EditorView.lineWrapping,
    ];
    if (placeholder) base.push(placeholderExt(placeholder));
    return base;
  }, [language, placeholder]);

  return (
    <CodeMirror
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
