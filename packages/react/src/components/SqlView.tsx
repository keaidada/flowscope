import { useMemo, useCallback, useEffect, useRef, type JSX } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { sql } from '@codemirror/lang-sql';
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view';
import { StateField, StateEffect, RangeSet } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';

import { useLineage } from '../store';
import type { SqlViewProps } from '../types';

type HighlightRange = { from: number; to: number; className: string };

const setHighlights = StateEffect.define<HighlightRange[]>();

/** Line-level highlight (for search result): highlights entire line(s) */
const setLineHighlights = StateEffect.define<number[]>(); // line positions (doc offsets)

const highlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(highlights, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHighlights)) {
        if (effect.value.length === 0) {
          return Decoration.none;
        }
        const marks = effect.value.map(({ from, to, className }) =>
          Decoration.mark({ class: className }).range(from, to)
        );
        return Decoration.set(marks);
      }
    }
    if (tr.docChanged) {
      return highlights.map(tr.changes);
    }
    return highlights;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const searchLineHighlight = Decoration.line({ class: 'flowscope-sql-search-line' });

const lineHighlightField = StateField.define<DecorationSet>({
  create() {
    return RangeSet.empty;
  },
  update(decos, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLineHighlights)) {
        if (effect.value.length === 0) {
          return RangeSet.empty;
        }
        const lineDecos = effect.value.map((pos) => searchLineHighlight.range(pos));
        return RangeSet.of(lineDecos, true);
      }
    }
    if (tr.docChanged) {
      return decos.map(tr.changes);
    }
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const baseTheme = EditorView.baseTheme({
  '.flowscope-sql-highlight-active': {
    backgroundColor: 'rgba(253, 224, 71, 0.6)',
    borderRadius: '2px',
  },
  '.flowscope-sql-search-line': {
    backgroundColor: 'rgba(253, 224, 71, 0.35)',
  },
  '.flowscope-sql-highlight-error': {
    backgroundColor: 'rgba(239, 72, 111, 0.25)',
    borderRadius: '2px',
  },
  '.flowscope-sql-highlight-warning': {
    backgroundColor: 'rgba(244, 164, 98, 0.25)',
    borderRadius: '2px',
  },
  '.flowscope-sql-highlight-info': {
    backgroundColor: 'rgba(76, 97, 255, 0.15)',
    borderRadius: '2px',
  },
});

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

  // Warn in dev mode if highlightedSpan is passed without value (it will be ignored)
  if (process.env.NODE_ENV !== 'production' && !isControlled && highlightedSpanProp !== undefined) {
    console.warn(
      'SqlView: `highlightedSpan` prop is ignored in uncontrolled mode. Pass a `value` prop to use controlled mode.'
    );
  }

  const sqlText = isControlled ? value : state.sql;
  // In controlled mode, prefer the prop; in uncontrolled mode, use store state
  // Normalize undefined to null for consistent type handling downstream
  const highlightedSpan = isControlled ? (highlightedSpanProp ?? null) : state.highlightedSpan;
  const issueHighlights = useMemo<HighlightRange[]>(() => {
    if (isControlled) {
      return [];
    }
    const issues = state.result?.issues ?? [];
    return issues
      .filter((issue) => issue.span)
      .map((issue) => {
        const className =
          issue.severity === 'error'
            ? 'flowscope-sql-highlight-error'
            : issue.severity === 'warning'
              ? 'flowscope-sql-highlight-warning'
              : 'flowscope-sql-highlight-info';
        return {
          from: issue.span!.start,
          to: issue.span!.end,
          className,
        };
      });
  }, [state.result, isControlled]);

  const editorRef = useRef<ReactCodeMirrorRef>(null);

  const extensions = useMemo(
    () => [
      sql(),
      highlightField,
      lineHighlightField,
      baseTheme,
      ...(lineWrapping ? [EditorView.lineWrapping] : []),
      EditorView.editable.of(editable),
    ],
    [editable, lineWrapping]
  );

  const theme = useMemo(() => (isDark ? oneDark : 'light'), [isDark]);

  const handleChange = useCallback(
    (val: string) => {
      if (!isControlled) {
        actions.setSql(val);
      }
      onChange?.(val);
    },
    [actions, onChange, isControlled]
  );

  useEffect(() => {
    const view = editorRef.current?.view;
    if (!view) return;

    // Mark decorations (issue highlights + inline text highlight)
    const ranges: HighlightRange[] = [];
    if (!isControlled) {
      ranges.push(...issueHighlights);
    }
    if (highlightedSpan) {
      ranges.push({
        from: highlightedSpan.start,
        to: highlightedSpan.end,
        className: 'flowscope-sql-highlight-active',
      });
    }

    view.dispatch({
      effects: setHighlights.of(ranges),
    });

    // Line decoration (full-line background for search highlight)
    if (highlightedSpan) {
      const line = view.state.doc.lineAt(highlightedSpan.start);
      view.dispatch({
        effects: setLineHighlights.of([line.from]),
      });
      // Scroll into view
      view.dispatch({
        selection: { anchor: highlightedSpan.start },
        scrollIntoView: true,
      });
    } else {
      view.dispatch({
        effects: setLineHighlights.of([]),
      });
    }
  }, [highlightedSpan, issueHighlights, isControlled]);

  return (
    <div className={`flowscope-sql-view ${className || ''}`}>
      <CodeMirror
        ref={editorRef}
        value={sqlText}
        onChange={handleChange}
        extensions={extensions}
        editable={editable}
        theme={theme}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          foldGutter: true,
        }}
        className="flowscope-codemirror"
      />
    </div>
  );
}
