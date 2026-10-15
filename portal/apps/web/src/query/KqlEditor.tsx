import { useEffect, useRef, useState } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
// Only the editor features Query Studio uses — not every language and contribution in monaco-editor.
import 'monaco-editor/editor/browser/coreCommands';
import 'monaco-editor/features/codicon/register';
import 'monaco-editor/features/find/register';
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/comment/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/wordOperations/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/placeholderText/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/snippet/register';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController';
import { fonts, THEME_NAMES, type ThemeName } from '@adminforge/design-tokens';
import { Skeleton, useHtmlAttribute, useMediaQuery } from '@adminforge/ui';
import {
  completionWords,
  KQL_LANGUAGE_ID,
  kqlConfiguration,
  kqlMonarch,
  type CompletionKind,
} from './kql-language';
import { monacoTheme, monacoThemeName } from './monaco-theme';

/**
 * The Monaco editor for KQL. Loaded as its own chunk (never in the first load) and bundled locally: no CDN, so the
 * CSP stays `script-src 'self'`; its one worker is served from the same origin.
 */

(globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
  getWorker: () =>
    new Worker(new URL('./editor.worker.ts', import.meta.url), { type: 'module', name: 'monaco-editor' }),
};
loader.config({ monaco });

// Completion data shared by the one provider (Monaco registers providers per language, not per editor).
let completionTables: readonly string[] = [];
let completionColumns: readonly string[] = [];
let registered = false;

const KIND: Record<CompletionKind, monaco.languages.CompletionItemKind> = {
  keyword: monaco.languages.CompletionItemKind.Keyword,
  function: monaco.languages.CompletionItemKind.Function,
  table: monaco.languages.CompletionItemKind.Class,
  column: monaco.languages.CompletionItemKind.Field,
};

function registerKql() {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: KQL_LANGUAGE_ID, aliases: ['KQL', 'Kusto'] });
  monaco.languages.setLanguageConfiguration(KQL_LANGUAGE_ID, kqlConfiguration);
  monaco.languages.registerCompletionItemProvider(KQL_LANGUAGE_ID, {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
      return {
        suggestions: completionWords(completionTables, completionColumns).map((w) => ({
          label: w.label,
          kind: KIND[w.kind],
          detail: w.kind,
          insertText: w.kind === 'function' ? `${w.label}($0)` : w.label,
          ...(w.kind === 'function'
            ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
            : {}),
          range,
        })),
      };
    },
  });
}

function defineThemes() {
  for (const t of THEME_NAMES) monaco.editor.defineTheme(monacoThemeName(t), monacoTheme(t));
}

const isTheme = (v: string | null): v is ThemeName => (THEME_NAMES as readonly string[]).includes(v ?? '');

export interface KqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl/⌘ + Enter. */
  onRun: () => void;
  /** Tables offered by completion and highlighted as tables. */
  tables: readonly string[];
  /** Column names of the last result, offered by completion. */
  columns?: readonly string[];
  ariaLabel: string;
  placeholder?: string;
  /** Receives a focus function once the editor is ready. */
  onReady?: (api: { focus: () => void }) => void;
  minHeight?: number;
  maxHeight?: number;
}

export default function KqlEditor({
  value,
  onChange,
  onRun,
  tables,
  columns,
  ariaLabel,
  placeholder,
  onReady,
  minHeight = 168,
  maxHeight = 440,
}: KqlEditorProps) {
  const themeAttr = useHtmlAttribute('data-theme');
  const theme: ThemeName = isTheme(themeAttr) ? themeAttr : 'steel';
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [height, setHeight] = useState(minHeight);
  const onRunRef = useRef(onRun);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    onRunRef.current = onRun;
  }, [onRun]);

  useEffect(() => {
    completionColumns = columns ?? [];
  }, [columns]);

  // Highlighting and completion know the current source's tables.
  useEffect(() => {
    completionTables = tables;
    registerKql();
    monaco.languages.setMonarchTokensProvider(KQL_LANGUAGE_ID, kqlMonarch(tables));
  }, [tables]);

  // Re-derive the themes from the live tokens whenever the app theme changes (appearance overrides included).
  useEffect(() => {
    defineThemes();
    monaco.editor.setTheme(monacoThemeName(theme));
  }, [theme]);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor as unknown as monaco.editor.IStandaloneCodeEditor;
    const ed = editorRef.current;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current());
    const fit = () => setHeight(Math.min(maxHeight, Math.max(minHeight, ed.getContentHeight())));
    ed.onDidContentSizeChange(fit);
    fit();
    // Web fonts may finish loading after the first layout; measure again so the cursor lines up.
    void document.fonts?.ready.then(() => monaco.editor.remeasureFonts());
    onReady?.({ focus: () => ed.focus() });
  };

  return (
    <Editor
      value={value}
      onChange={(v) => onChange(v ?? '')}
      language={KQL_LANGUAGE_ID}
      theme={monacoThemeName(theme)}
      height={height}
      beforeMount={() => {
        completionTables = tables;
        registerKql();
        monaco.languages.setMonarchTokensProvider(KQL_LANGUAGE_ID, kqlMonarch(tables));
        defineThemes();
      }}
      onMount={handleMount}
      loading={<Skeleton shape="block" className="h-full w-full" />}
      wrapperProps={{ className: 'af-kql-editor', 'data-testid': 'kql-editor' }}
      options={{
        ariaLabel,
        placeholder,
        fontFamily: fonts.mono,
        fontSize: 13,
        lineHeight: 20,
        fontLigatures: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        wrappingIndent: 'indent',
        lineNumbersMinChars: 3,
        lineDecorationsWidth: 8,
        glyphMargin: false,
        folding: false,
        renderLineHighlight: 'line',
        padding: { top: 12, bottom: 12 },
        // Tab moves focus out of the editor (no keyboard trap); KQL needs no tab characters.
        tabFocusMode: true,
        tabSize: 2,
        insertSpaces: true,
        automaticLayout: true,
        fixedOverflowWidgets: true,
        wordBasedSuggestions: 'off',
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        cursorBlinking: reducedMotion ? 'solid' : 'smooth',
        cursorSmoothCaretAnimation: 'off',
        smoothScrolling: !reducedMotion,
        stickyScroll: { enabled: false },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
        accessibilitySupport: 'auto',
        // The browser's own menu (copy, paste) instead of Monaco's command menu, which is a large module.
        contextmenu: false,
      }}
    />
  );
}
