import { readFileSync } from 'node:fs';

import browserslist from 'browserslist';
import { describe, expect, it } from 'vitest';

import { esbuildTargets } from './targets.js';

const queriesFromRoot = (): string[] =>
  readFileSync(new URL('../../../.browserslistrc', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

describe('translating supported browsers into build targets', () => {
  it('maps each browserslist engine onto the esbuild engine that downlevels for it', () => {
    expect(
      esbuildTargets(['chrome 143', 'ios_saf 26.4-26.6', 'and_chr 142', 'safari 26.5']),
    ).toEqual(['chrome142', 'ios26.4', 'safari26.5']);
  });

  it('keeps the oldest version of an engine, because that is the one that needs the downlevel', () => {
    expect(esbuildTargets(['chrome 143', 'chrome 141', 'chrome 142'])).toEqual(['chrome141']);
    // A version with fewer parts than the one it is compared against is still comparable.
    expect(esbuildTargets(['ios_saf 26.1', 'ios_saf 26', 'ios_saf 26.2'])).toEqual(['ios26']);
  });

  it('refuses an engine it cannot express, rather than silently dropping the target', () => {
    expect(() => esbuildTargets(['kaios 3.0'])).toThrow(/kaios/u);
  });

  it('covers every browser the repository claims to support', () => {
    const targets = esbuildTargets(browserslist(queriesFromRoot()));

    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toMatch(/^(chrome|ios|safari|edge|firefox)[\d.]+$/u);
    expect(targets.some((target) => target.startsWith('chrome'))).toBe(true);
    expect(targets.some((target) => target.startsWith('ios'))).toBe(true);
  });
});
