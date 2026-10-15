import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { emitCss, emitEchartsTheme, emitTailwindTheme } from './emit';
import { THEME_NAMES } from './tokens';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
mkdirSync(dist, { recursive: true });
writeFileSync(`${dist}tokens.css`, emitCss());
writeFileSync(`${dist}tailwind-theme.css`, emitTailwindTheme());
for (const name of THEME_NAMES)
  writeFileSync(`${dist}echarts-${name}.json`, `${JSON.stringify(emitEchartsTheme(name), null, 2)}\n`);
console.log(`design-tokens: wrote ${2 + THEME_NAMES.length} files to dist/`);
