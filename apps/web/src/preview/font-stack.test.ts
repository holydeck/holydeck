// LANG-02 pins the Tamil font stack: the system's own Tamil faces, never a downloaded one. The preview
// measures and paints through these variables, so a change here would silently move every line break.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../static/app.css', import.meta.url), 'utf8');

function variable(name: string): string | undefined {
  return new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
}

describe('font stack', () => {
  it('keeps the LANG-02 Tamil stack exactly', () => {
    expect(variable('--font-tamil')).toBe('"Noto Sans Tamil", "Tamil MN", "Tamil Sangam MN", "Latha", "Nirmala UI", sans-serif');
  });

  it('keeps Latin text on the system face', () => {
    expect(variable('--font-latin')).toBe('system-ui, sans-serif');
  });

  it('downloads no font face', () => {
    expect(css).not.toMatch(/@font-face\s*\{[^}]*src:/);
  });
});
