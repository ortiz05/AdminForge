import type { editor } from 'monaco-editor/editor/editor.api';
import { contrastRatio, resolveHex, themeMeta, themes, type SemanticKey, type ThemeName } from '@adminforge/design-tokens';

/**
 * Monaco themes derived from the design tokens — no colour is defined here. Values come from the live CSS custom
 * properties (so Admin → Appearance overrides apply), falling back to the token source for keys that are not a
 * single hex value at runtime.
 */

const HEX = /^#[0-9a-f]{6}$/i;

export function tokenHex(theme: ThemeName, key: SemanticKey, root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement): string {
  const live = root ? getComputedStyle(root).getPropertyValue(`--af-${key}`).trim() : '';
  if (HEX.test(live) && root?.dataset.theme === theme) return live.toUpperCase();
  try {
    return resolveHex(themes[theme][key]);
  } catch {
    return resolveHex(themes[theme].fg);
  }
}

/** `#RRGGBB` + alpha (0–1) → `#RRGGBBAA`, the form Monaco's colour registry accepts. */
export const withAlpha = (hex: string, alpha: number) =>
  `${hex}${Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0')}`;

export const monacoThemeName = (theme: ThemeName) => `af-${theme}`;

/** Text on the editor background must reach WCAG AA (4.5:1). */
export const MIN_TEXT_CONTRAST = 4.5;

/**
 * Syntax colours, each with fallbacks: the first token that reaches AA on the editor background wins. Status and
 * chart tokens are validated against canvas/panel/raised, not the darker `sunken` of light themes (or an accent
 * override), so the editor checks at runtime instead of trusting them.
 */
export const SYNTAX: Record<string, SemanticKey[]> = {
  comment: ['fg-3', 'fg-2'],
  keyword: ['accent', 'accent-strong', 'fg'],
  predefined: ['chart-4', 'accent-strong', 'fg'],
  string: ['ok', 'fg-2'],
  'string.invalid': ['crit', 'fg'],
  number: ['warn', 'fg-2'],
  operator: ['fg-2', 'fg'],
};

export function monacoTheme(theme: ThemeName): editor.IStandaloneThemeData {
  const c = (key: SemanticKey) => tokenHex(theme, key);
  const background = c('sunken');
  const readable = (keys: SemanticKey[]) => (keys.map(c).find((hex) => contrastRatio(hex, background) >= MIN_TEXT_CONTRAST) ?? c('fg')).slice(1);
  const base = theme === 'contrast' ? 'hc-black' : themeMeta[theme].scheme === 'light' ? 'vs' : 'vs-dark';
  return {
    base,
    inherit: true,
    rules: [
      { token: '', foreground: readable(['fg']) },
      { token: 'comment', foreground: readable(SYNTAX.comment!), fontStyle: 'italic' },
      { token: 'keyword', foreground: readable(SYNTAX.keyword!) },
      { token: 'predefined', foreground: readable(SYNTAX.predefined!) },
      { token: 'type', foreground: readable(['fg']), fontStyle: 'bold' },
      { token: 'identifier', foreground: readable(['fg']) },
      { token: 'string', foreground: readable(SYNTAX.string!) },
      { token: 'string.invalid', foreground: readable(SYNTAX['string.invalid']!) },
      { token: 'number', foreground: readable(SYNTAX.number!) },
      { token: 'number.timespan', foreground: readable(SYNTAX.number!) },
      { token: 'operator', foreground: readable(SYNTAX.operator!) },
      { token: 'delimiter', foreground: readable(SYNTAX.operator!) },
      { token: 'delimiter.pipe', foreground: readable(SYNTAX.keyword!), fontStyle: 'bold' },
    ],
    colors: {
      'editor.background': background,
      'editor.foreground': c('fg'),
      'editorLineNumber.foreground': c('fg-3'),
      'editorLineNumber.activeForeground': c('fg-2'),
      'editorCursor.foreground': c('accent'),
      'editor.selectionBackground': withAlpha(c('accent'), 0.3),
      'editor.inactiveSelectionBackground': withAlpha(c('accent'), 0.16),
      'editor.selectionHighlightBackground': withAlpha(c('accent'), 0.14),
      'editor.wordHighlightBackground': withAlpha(c('accent'), 0.14),
      'editor.findMatchBackground': withAlpha(c('warn'), 0.35),
      'editor.findMatchHighlightBackground': withAlpha(c('warn'), 0.18),
      'editor.lineHighlightBackground': withAlpha(c('fg'), 0.04),
      'editor.lineHighlightBorder': withAlpha(c('fg'), 0),
      'editorBracketMatch.background': withAlpha(c('accent'), 0.18),
      'editorBracketMatch.border': withAlpha(c('accent'), 0.6),
      'editorIndentGuide.background1': c('line'),
      'editorWhitespace.foreground': c('line-strong'),
      'editorWidget.background': c('raised'),
      'editorWidget.foreground': c('fg'),
      'editorWidget.border': c('line-strong'),
      'editorSuggestWidget.background': c('raised'),
      'editorSuggestWidget.border': c('line-strong'),
      'editorSuggestWidget.foreground': c('fg'),
      'editorSuggestWidget.selectedBackground': withAlpha(c('accent'), 0.2),
      'editorSuggestWidget.highlightForeground': c('accent'),
      'editorHoverWidget.background': c('raised'),
      'editorHoverWidget.border': c('line-strong'),
      'input.background': c('sunken'),
      'input.foreground': c('fg'),
      'input.border': c('line-strong'),
      'focusBorder': c('focus'),
      'scrollbarSlider.background': withAlpha(c('fg-3'), 0.3),
      'scrollbarSlider.hoverBackground': withAlpha(c('fg-3'), 0.45),
      'scrollbarSlider.activeBackground': withAlpha(c('fg-3'), 0.6),
      'editorGutter.background': c('sunken'),
      'editorOverviewRuler.border': withAlpha(c('fg'), 0),
    },
  };
}
