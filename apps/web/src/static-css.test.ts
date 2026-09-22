// The static styles are shipped without a runtime stylesheet layer, so their accessibility contracts
// are checked at the artifact boundary: every CSS file is scanned exactly as the browser receives it.

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const staticDirectory = new URL('./static/', import.meta.url);
const stylesheets = readdirSync(staticDirectory)
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, source: readFileSync(new URL(name, staticDirectory), 'utf8') }));
const appStyles = stylesheets.find(({ name }) => name === 'app.css')?.source ?? '';

const durationInMilliseconds = (value: string): number => {
  const match = /^(\d+(?:\.\d+)?)(ms|s)$/u.exec(value);
  if (match === null) throw new Error(`Invalid motion duration: ${value}`);
  return Number(match[1]) * (match[2] === 's' ? 1_000 : 1);
};

describe('the shipped stylesheets', () => {
  it('use only motion tokens whose resolved durations do not exceed 240ms', () => {
    const tokens = new Map<string, string>();
    for (const { source } of stylesheets) {
      for (const match of source.matchAll(/(--motion-[\w-]+)\s*:\s*(\d+(?:\.\d+)?(?:ms|s))\s*;/gu)) {
        tokens.set(match[1] ?? '', match[2] ?? '');
      }
    }

    expect(Object.fromEntries(tokens)).toEqual({
      '--motion-feedback': '120ms',
      '--motion-panel': '180ms',
      '--motion-max': '240ms',
    });

    for (const [token, duration] of tokens) {
      expect(durationInMilliseconds(duration), token).toBeLessThanOrEqual(240);
    }

    for (const { name, source } of stylesheets) {
      for (const declaration of source.matchAll(/\b(?:transition|animation)(?:-[\w-]+)?\s*:\s*([^;}]+)/gu)) {
        const value = declaration[1] ?? '';
        expect(value, `${name} contains a literal motion duration`).not.toMatch(/(?:^|[\s,(])\d+(?:\.\d+)?(?:ms|s)\b/u);
        for (const reference of value.matchAll(/var\((--[\w-]+)\)/gu)) {
          const token = reference[1] ?? '';
          expect(token, `${name} uses a non-motion duration token`).toMatch(/^--motion-/u);
          expect(tokens.has(token), `${name} uses unresolved ${token}`).toBe(true);
          expect(durationInMilliseconds(tokens.get(token) ?? ''), token).toBeLessThanOrEqual(240);
        }
      }
    }
  });

  it('turns transform and animated motion off when reduced motion is preferred', () => {
    const source = stylesheets.map(({ source: css }) => css).join('\n');
    expect(source).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
    expect(source).toMatch(/animation\s*:\s*none\s*!important/u);
    expect(source).toMatch(/transition\s*:\s*none\s*!important/u);
    expect(source).toMatch(/transform\s*:\s*none\s*!important/u);
  });

  it('uses logical declarations instead of physical inline spacing and positions', () => {
    const declarations = appStyles.replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(declarations).not.toMatch(
      /(?:^|[;{])\s*(?:margin-left|margin-right|padding-left|padding-right|left|right)\s*:/u,
    );
  });

  it('lets buttons and navigation controls wrap at 767px without shrinking below 44px', () => {
    const narrow = /@media\s*\(max-width:\s*767px\)\s*\{([\s\S]*?)\n\}/u.exec(appStyles)?.[1] ?? '';
    expect(narrow).toMatch(/button,\s*nav a\s*\{/u);
    expect(narrow).toMatch(/white-space:\s*normal/u);
    expect(narrow).toMatch(/overflow-wrap:\s*anywhere/u);
    expect(narrow).toMatch(/overflow:\s*visible/u);
    expect(narrow).toMatch(/min-block-size:\s*44px/u);
    expect(narrow).not.toMatch(/text-overflow|white-space:\s*nowrap|overflow:\s*hidden/u);
  });
});
