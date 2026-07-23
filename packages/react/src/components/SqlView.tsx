import { useMemo, useCallback, useEffect, useRef, type JSX } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { sql } from '@codemirror/lang-sql';
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view';
import { StateField, StateEffect, RangeSet } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { search, closeSearchPanel } from '@codemirror/search';

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
  searchLabels,
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
      search({ top: true }),
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

  // 点击编辑器外部时关闭搜索面板
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const view = editorRef.current?.view;
      if (!view) return;
      if (view.dom.contains(e.target as Node)) return;
      // 关闭搜索面板（多次调用防抖）
      closeSearchPanel(view);
      // 阻止编辑器因点击外部重新获取焦点时自动打开搜索面板
      window.addEventListener('focus', (fe) => {
        // 搜索面板关闭后如果编辑器获得焦点，它可能会重新打开
        // 在这里我们不需要额外处理，closeSearchPanel 已经关闭了
      }, { once: true });
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, []);

  // 搜索面板标签国际化（只改文本节点，不动复选框等 input）
  useEffect(() => {
    if (!searchLabels) return;
    const root = document.querySelector('.flowscope-codemirror .cm-editor') as HTMLElement | null
      ?? editorRef.current?.view?.dom as HTMLElement | null;
    if (!root) return;
    const entries = Object.entries(searchLabels);
    const observer = new MutationObserver(() => {
      const panel = root.querySelector('.cm-panel.cm-search');
      if (!panel) return;
      for (const [orig, trans] of entries) {
        panel.querySelectorAll('label, .cm-button, .cm-search button').forEach((el) => {
          // 只改最后一个文本节点（复选框后跟的文本），不动子 input
          const textNodes: Text[] = [];
          el.childNodes.forEach(n => { if (n.nodeType === Node.TEXT_NODE) textNodes.push(n as Text); });
          const lastText = textNodes[textNodes.length - 1];
          if (lastText && lastText.textContent?.trim() === orig) {
            lastText.textContent = ' ' + trans;
          }
        });
        // 也匹配纯文本标签（无子元素的 label）
        panel.querySelectorAll('.cm-search label:not(:has(*))').forEach((el) => {
          if (el.textContent?.trim() === orig) el.textContent = trans;
        });
      }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [searchLabels]);

  return (
    <div className={`flowscope-sql-view ${className || ''}`}>
      <style>{`
        .flowscope-codemirror .cm-editor { position: relative; }
        .flowscope-codemirror .cm-editor .cm-scroller { flex: 1; }
        .flowscope-codemirror .cm-editor .cm-panel.cm-search {
          position: absolute;
          top: 4px;
          right: 4px;
          z-index: 10;
          background: hsl(var(--background));
          border: 1px solid hsl(var(--border));
          border-radius: 6px;
          padding: 8px 10px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15);
          width: auto;
          min-width: 300px;
        }
        .flowscope-codemirror .cm-editor .cm-panel.cm-search label,
        .flowscope-codemirror .cm-editor .cm-panel.cm-search .cm-button {
          font-size: 12px;
          color: hsl(var(--muted-foreground));
        }
        .flowscope-codemirror .cm-editor .cm-panel.cm-search input {
          font-size: 12px;
          padding: 4px 8px;
          background: hsl(var(--background));
          border: 1px solid hsl(var(--input));
          border-radius: 4px;
          color: hsl(var(--foreground));
        }
        .flowscope-codemirror .cm-editor .cm-panel.cm-search input:focus {
          outline: none;
          border-color: hsl(var(--ring));
          box-shadow: 0 0 0 2px hsl(var(--ring) / 0.2);
        }
        .flowscope-codemirror .cm-editor .cm-panel.cm-search .cm-button {
          background: hsl(var(--secondary));
          border: 1px solid hsl(var(--border));
          border-radius: 4px;
          padding: 2px 8px;
          cursor: pointer;
          font-size: 12px;
          color: hsl(var(--secondary-foreground));
        }
        .flowscope-codemirror .cm-editor .cm-panel.cm-search .cm-button:hover {
          background: hsl(var(--secondary) / 0.8);
        }
        .flowscope-codemirror .cm-editor .cm-panel.cm-search .cm-textfield { margin: 0 2px; }
        .flowscope-codemirror .cm-editor .cm-panel.cm-search [name=replace] { margin-left: 4px; }
      `}</style>
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
