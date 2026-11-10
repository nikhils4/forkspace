import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { HighlightStyle, bracketMatching, foldGutter, syntaxHighlighting } from '@codemirror/language';
import { unifiedMergeView } from '@codemirror/merge';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

function languageFor(path: string): Extension {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const name = path.split('/').pop()?.toLowerCase() ?? '';
  if (['ts', 'mts', 'cts'].includes(ext)) return javascript({ typescript: true });
  if (ext === 'tsx') return javascript({ typescript: true, jsx: true });
  if (['js', 'mjs', 'cjs'].includes(ext)) return javascript();
  if (ext === 'jsx') return javascript({ jsx: true });
  if (['json', 'jsonc', 'webmanifest'].includes(ext)) return json();
  if (['css', 'scss', 'less'].includes(ext)) return css();
  if (['html', 'htm', 'svg', 'xml', 'vue', 'svelte'].includes(ext)) return html();
  if (['md', 'mdx', 'markdown'].includes(ext)) return markdown();
  if (['py', 'pyi'].includes(ext)) return python();
  if (ext === 'rs') return rust();
  if (ext === 'go') return go();
  if (['yml', 'yaml'].includes(ext) || name === '.prettierrc') return yaml();
  if (ext === 'sql') return sql();
  return [];
}

// Colours come from CSS variables so light and dark themes both work.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-fn)' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--syn-prop)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator], color: 'var(--syn-punct)' },
  { tag: [t.heading], color: 'var(--syn-type)', fontWeight: '700' },
  { tag: [t.link, t.url], color: 'var(--syn-string)', textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
  { tag: [t.definition(t.variableName)], color: 'var(--syn-def)' },
  { tag: [t.self, t.special(t.variableName)], color: 'var(--syn-keyword)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', background: 'transparent', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65' },
  '.cm-content': { padding: '10px 0 40vh' },
  '.cm-gutters': { background: 'var(--bg)', border: 'none', color: 'var(--text-3)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 16px', minWidth: '44px' },
  '.cm-activeLine': { background: 'color-mix(in srgb, var(--text) 3.5%, transparent)' },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--text-2)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { background: 'var(--accent-soft) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-3)', padding: '0 4px' },
  '.cm-changedLine': { background: 'color-mix(in srgb, var(--add) 9%, transparent) !important' },
  '.cm-changedText': { background: 'color-mix(in srgb, var(--add) 22%, transparent) !important' },
  '.cm-deletedChunk': { background: 'color-mix(in srgb, var(--del) 9%, transparent) !important', padding: '0' },
  '.cm-deletedChunk del': { textDecoration: 'none', background: 'color-mix(in srgb, var(--del) 22%, transparent)' },
  '.cm-changeGutter': { width: '3px', paddingLeft: '0' },
  '.cm-changedLineGutter': { background: 'var(--add)' },
  '.cm-deletedLineGutter': { background: 'var(--del)' },
  '.cm-collapsedLines': {
    background: 'var(--surface-2)',
    color: 'var(--text-3)',
    fontFamily: 'var(--font)',
    fontSize: '12px',
    padding: '4px 16px',
    borderTop: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
  },
  '.cm-panels': { background: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panels input, .cm-panels button': { fontFamily: 'var(--font)' },
  '.cm-textfield': { background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: '6px', color: 'var(--text)' },
  '.cm-button': { background: 'var(--surface-2)', backgroundImage: 'none', border: '1px solid var(--border-2)', borderRadius: '6px', color: 'var(--text)' },
  '.cm-searchMatch': { background: 'color-mix(in srgb, var(--warn) 25%, transparent)' },
  '.cm-searchMatch-selected': { background: 'color-mix(in srgb, var(--warn) 45%, transparent)' },
  '.cm-selectionMatch': { background: 'var(--accent-soft)' },
});

export interface CodeEditorProps {
  path: string;
  text: string;
  /** Content when the thread started; shows an inline diff when `diff` is on. */
  base?: string;
  diff: boolean;
  /** Wrap long lines (phones). */
  wrap?: boolean;
}

export default function CodeEditor({ path, text, base, diff, wrap }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lastPath = useRef(path);

  useEffect(() => {
    const extensions: Extension[] = [
      lineNumbers(),
      foldGutter(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      bracketMatching(),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of(searchKeymap),
      syntaxHighlighting(highlight),
      theme,
      languageFor(path),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': `Contents of ${path}` }),
    ];
    if (wrap) extensions.push(EditorView.lineWrapping);
    if (diff && base != null && base !== text)
      extensions.push(
        unifiedMergeView({ original: base, mergeControls: false, gutter: true, highlightChanges: true, syntaxHighlightDeletions: true, collapseUnchanged: { margin: 3, minSize: 8 } }),
      );
    const state = EditorState.create({ doc: text, extensions });

    if (!view.current) {
      view.current = new EditorView({ state, parent: host.current! });
      return;
    }
    // Same file refreshed (agent edited it): keep the scroll position.
    const scroll = lastPath.current === path ? view.current.scrollDOM.scrollTop : 0;
    view.current.setState(state);
    view.current.scrollDOM.scrollTop = scroll;
    lastPath.current = path;
  }, [path, text, base, diff, wrap]);

  useEffect(
    () => () => {
      view.current?.destroy();
      view.current = null;
    },
    [],
  );

  return <div className="code-editor" ref={host} />;
}
