import { useCallback, useEffect, useRef, useMemo, type JSX } from 'react';
import Editor, { type OnMount, type OnChange } from '@monaco-editor/react';

import { useLineage } from '../store';
import type { SqlViewProps } from '../types';

export function SqlView({
  className,
  editable = false,
  onChange,
  value,
  isDark,
  highlightedSpan: highlightedSpanProp,
  lineWrapping = true,
}: SqlViewProps): JSX.Element {
  const { state, actions } = useLineage();
  const isControlled = value !== undefined;
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const sqlText = isControlled ? value : state.sql;
  const highlightedSpan = isControlled ? (highlightedSpanProp ?? null) : state.highlightedSpan;

  const issueHighlights = useMemo(
    () => {
      if (isControlled) return [];
      return (state.result?.issues ?? [])
        .filter((issue) => issue.span)
        .map((issue) => ({
          from: issue.span!.start,
          to: issue.span!.end,
          className: issue.severity === 'error'
            ? 'error' : issue.severity === 'warning'
            ? 'warning' : 'info',
        }));
    },
    [state.result, isControlled],
  );

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const handleChange: OnChange = useCallback(
    (val) => {
      if (val === undefined) return;
      if (!isControlled) actions.setSql(val);
      onChange?.(val);
    },
    [actions, onChange, isControlled],
  );

  // Apply decorations (issue highlights + active span highlight)
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const model = editor.getModel();
    if (!model) return;

    const newDecorations: Array<{
      range: any;
      options: {
        inlineClassName?: string;
        className?: string;
        isWholeLine?: boolean;
        linesDecorationsClassName?: string;
      };
    }> = [];

    // Issue highlights
    for (const h of issueHighlights) {
      const startPos = model.getPositionAt(h.from);
      const endPos = model.getPositionAt(h.to);
      const sevClass = h.className === 'error'
        ? 'flowscope-sql-highlight-error'
        : h.className === 'warning'
        ? 'flowscope-sql-highlight-warning'
        : 'flowscope-sql-highlight-info';

      newDecorations.push({
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        },
        options: { inlineClassName: sevClass },
      });
    }

    // Active span highlight (search/jump result)
    if (highlightedSpan) {
      const startPos = model.getPositionAt(highlightedSpan.start);
      const endPos = model.getPositionAt(highlightedSpan.end);
      newDecorations.push({
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        },
        options: {
          inlineClassName: 'flowscope-sql-highlight-active',
        },
      });
      // Scroll to highlight
      editor.revealLineInCenter(startPos.lineNumber);
    }

    decorationsRef.current = editor.deltaDecorations(
      decorationsRef.current,
      newDecorations,
    );
  }, [highlightedSpan, issueHighlights]);

  return (
    <div className={`flowscope-sql-view monaco-editor-wrapper ${className || ''}`}>
      <style>{`
        .monaco-editor-wrapper { position: relative; }
        .monaco-editor-wrapper .monaco-editor { border-radius: 4px; }
        .flowscope-sql-highlight-active { background-color: rgba(253,224,71,0.6); }
        .flowscope-sql-highlight-error { background-color: rgba(239,72,111,0.25); }
        .flowscope-sql-highlight-warning { background-color: rgba(244,164,98,0.25); }
        .flowscope-sql-highlight-info { background-color: rgba(76,97,255,0.15); }
      `}</style>
      <Editor
        height="100%"
        width="100%"
        language="sql"
        theme={isDark ? 'vs-dark' : 'vs'}
        value={sqlText}
        onChange={handleChange}
        onMount={handleMount}
        loading={
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Loading editor...
          </div>
        }
        options={{
          readOnly: !editable,
          wordWrap: lineWrapping ? 'on' : 'off',
          minimap: { enabled: false },
          lineNumbers: 'on',
          folding: true,
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
          scrollBeyondLastLine: false,
          renderLineHighlight: 'line',
          automaticLayout: true,
          padding: { top: 4 },
          suggest: { showWords: true },
          tabSize: 2,
          insertSpaces: true,
          detectIndentation: false,
          quickSuggestions: false,
          // 搜索面板：Monaco 原生处理，自动关闭
        }}
      />
    </div>
  );
}
