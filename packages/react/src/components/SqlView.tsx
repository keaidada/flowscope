import { useCallback, useEffect, useRef, useMemo, useImperativeHandle, forwardRef } from 'react';
import Editor, { type OnMount, type OnChange } from '@monaco-editor/react';

import { useLineage } from '../store';
import type { SqlViewProps } from '../types';

export interface SqlViewHandle {
  foldAll: () => void;
  unfoldAll: () => void;
}

export const SqlView = forwardRef<SqlViewHandle, SqlViewProps>(function SqlView(props, ref) {
  const {
    className,
    editable = false,
    onChange,
    value,
    isDark,
    highlightedSpan: highlightedSpanProp,
    lineWrapping = true,
  } = props;
  const { state, actions } = useLineage();
  const isControlled = value !== undefined;
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const decorationsRef = useRef<string[]>([]);

  useImperativeHandle(
    ref,
    () => ({
      foldAll: () => {
        editorRef.current?.trigger('fold', 'editor.foldAll', null);
      },
      unfoldAll: () => {
        editorRef.current?.trigger('fold', 'editor.unfoldAll', null);
      },
    }),
    []
  );

  const sqlText = isControlled ? value : state.sql;
  const highlightedSpan = isControlled ? (highlightedSpanProp ?? null) : state.highlightedSpan;

  const issueHighlights = useMemo(() => {
    if (isControlled) return [];
    return (state.result?.issues ?? [])
      .filter((issue) => issue.span)
      .map((issue) => ({
        from: issue.span!.start,
        to: issue.span!.end,
        className:
          issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
      }));
  }, [state.result, isControlled]);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  // Register semicolon-based folding provider + Jinja highlighting for SQL
  const handleBeforeMount = useCallback((monaco: any) => {
    monaco.languages.registerFoldingRangeProvider('sql', {
      provideFoldingRanges(model: any) {
        const ranges: Array<{ start: number; end: number; kind?: number }> = [];
        const lineCount = model.getLineCount();

        // Find statement boundaries by semicolons
        let stmtStart = 1;
        for (let line = 1; line <= lineCount; line++) {
          const lineContent = model.getLineContent(line);
          const semiIdx = lineContent.lastIndexOf(';');
          if (semiIdx >= 0) {
            // Check if the semicolon is not inside a string
            const beforeSemi = lineContent.slice(0, semiIdx);
            const quotes = (beforeSemi.match(/['"]/g) || []).length;
            if (quotes % 2 === 0) {
              // End of statement at this line
              if (line > stmtStart) {
                ranges.push({
                  start: stmtStart,
                  end: line,
                });
              }
              stmtStart = line + 1;
            }
          }
        }
        // Last statement range if any
        if (lineCount >= stmtStart) {
          ranges.push({
            start: stmtStart,
            end: lineCount,
          });
        }

        return ranges;
      },
    });

    // Register a Monarch tokenizer that adds Jinja highlighting on top of SQL.
    // We re-register the 'sql' language with a Jinja-aware Monarch definition.
    const sqlLang = monaco.languages.getLanguages().find((l: any) => l.id === 'sql');
    if (sqlLang) {
      monaco.languages.register({
        id: 'flowscope-sql',
        extensions: [],
        aliases: [],
      });

      monaco.languages.setMonarchTokensProvider('flowscope-sql', {
        defaultToken: '',
        tokenPostfix: '.sql',
        ignoreCase: true,

        brackets: [
          { open: '[', close: ']', token: 'delimiter.square' },
          { open: '(', close: ')', token: 'delimiter.parenthesis' },
        ],

        keywords: [
          'select', 'from', 'where', 'and', 'or', 'not', 'insert', 'into', 'update',
          'delete', 'create', 'table', 'view', 'as', 'join', 'left', 'right', 'inner',
          'outer', 'on', 'group', 'by', 'order', 'having', 'limit', 'with', 'union',
          'all', 'distinct', 'case', 'when', 'then', 'else', 'end', 'merge', 'using',
          'values', 'set', 'over', 'partition', 'cast', 'if', 'coalesce', 'null',
        ],

        builtinFunctions: [
          'sum', 'count', 'avg', 'max', 'min', 'round', 'concat', 'substring',
          'length', 'trim', 'lower', 'upper', 'date', 'timestamp', 'coalesce',
          'nvl', 'abs', 'floor', 'ceil', 'row_number', 'rank', 'dense_rank', 'lag', 'lead',
        ],

        // Jinja expressions {{ }} and statements {% %}
        jinjaExpression: [
          [/\{\{/, 'jinja.delimiter', '@jinjaExprBody'],
          [/\{%/, 'jinja.delimiter', '@jinjaStmtBody'],
        ],
        jinjaExprBody: [
          [/\}\}/, 'jinja.delimiter', '@pop'],
          [/[^{}]+/, 'jinja.expression'],
          [/\{\{/, 'jinja.delimiter'],
          [/\}\}/, 'jinja.delimiter', '@pop'],
        ],
        jinjaStmtBody: [
          [/%\}/, 'jinja.delimiter', '@pop'],
          [/[^{%]+/, 'jinja.statement'],
          [/\{%/, 'jinja.delimiter'],
          [/%\}/, 'jinja.delimiter', '@pop'],
        ],

        tokenizer: {
          root: [
            { include: '@jinjaExpression' },
            [/\s+/, 'white'],
            [/--.*$/, 'comment'],
            [/\/\*.*\*\//, 'comment'],
            [/"([^"\\]|\\.)*$/, 'string.invalid'],
            [/'/, { token: 'string', next: '@string' }],
            [/[;,.()\[\]]/, 'delimiter'],
            [/[<>]=?|!=|=/, 'operator'],
            [/[0-9]+(\.[0-9]+)?/, 'number'],
            [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@builtinFunctions': 'predefined', '@default': 'identifier' } }],
          ],
          string: [
            [/'/, { token: 'string', next: '@pop' }],
            [/[^']+/, 'string'],
            [/'/, { token: 'string', next: '@pop' }],
          ],
        },
      });

      // Define theme colors for Jinja tokens
      monaco.editor.defineTheme('flowscope-sql-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'jinja.expression', foreground: '3b82f6', fontStyle: 'bold' },
          { token: 'jinja.delimiter', foreground: '3b82f6', fontStyle: 'bold' },
          { token: 'jinja.statement', foreground: 'a855f7', fontStyle: 'bold' },
        ],
      });
      monaco.editor.defineTheme('flowscope-sql-light', {
        base: 'vs',
        inherit: true,
        rules: [
          { token: 'jinja.expression', foreground: '2563eb', fontStyle: 'bold' },
          { token: 'jinja.delimiter', foreground: '2563eb', fontStyle: 'bold' },
          { token: 'jinja.statement', foreground: '9333ea', fontStyle: 'bold' },
        ],
      });
    }
  }, []);

  const handleChange: OnChange = useCallback(
    (val) => {
      if (val === undefined) return;
      if (!isControlled) actions.setSql(val);
      onChange?.(val);
    },
    [actions, onChange, isControlled]
  );

  // Apply decorations (issue highlights + active span highlight + jinja {{ }})
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
      const sevClass =
        h.className === 'error'
          ? 'capybara-sql-highlight-error'
          : h.className === 'warning'
            ? 'capybara-sql-highlight-warning'
            : 'capybara-sql-highlight-info';

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
          inlineClassName: 'capybara-sql-highlight-active',
        },
      });
      // Scroll to highlight
      editor.revealLineInCenter(startPos.lineNumber);
    }

    // Jinja highlighting — {{ expressions }} and {% statements %}, both
    // can span multiple lines. Expressions get blue, statements get purple.
    const text = model.getValue();
    const jinjaRegex = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g;
    let match;
    while ((match = jinjaRegex.exec(text)) !== null) {
      const isStatement = match[0].startsWith('{%');
      const startPos = model.getPositionAt(match.index);
      const endPos = model.getPositionAt(match.index + match[0].length);
      newDecorations.push({
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        },
        options: {
          inlineClassName: isStatement
            ? 'capybara-jinja-statement-highlight'
            : 'capybara-jinja-highlight',
        },
      });
    }

    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, newDecorations);
  }, [highlightedSpan, issueHighlights, sqlText]);

  return (
    <div className={`capybara-sql-view monaco-editor-wrapper ${className || ''}`}>
      <style>{`
        .monaco-editor-wrapper { position: relative; }
        .monaco-editor-wrapper .monaco-editor { border-radius: 4px; }
        .monaco-editor-wrapper .monaco-editor .find-widget.visible { top: 32px !important; }
        .capybara-sql-highlight-active { background-color: rgba(253,224,71,0.6); }
        .capybara-sql-highlight-error { background-color: rgba(239,72,111,0.25); }
        .capybara-sql-highlight-warning { background-color: rgba(244,164,98,0.25); }
        .capybara-sql-highlight-info { background-color: rgba(76,97,255,0.15); }
        .capybara-jinja-highlight {
          background-color: rgba(59,130,246,0.15);
          border-radius: 2px;
          font-weight: 600;
          color: #3b82f6;
        }
        .capybara-jinja-statement-highlight {
          background-color: rgba(168,85,247,0.15);
          border-radius: 2px;
          font-weight: 600;
          color: #a855f7;
        }
      `}</style>
      <Editor
        height="100%"
        width="100%"
        language="flowscope-sql"
        theme={isDark ? 'flowscope-sql-dark' : 'flowscope-sql-light'}
        value={sqlText}
        onChange={handleChange}
        onMount={handleMount}
        beforeMount={handleBeforeMount}
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
});
