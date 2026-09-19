import { describe, expect, it } from 'vitest';

import { PALETTE_OPEN_SHORTCUT, shortcutLabel } from './palette.js';

describe('shortcutLabel: the palette open shortcut, rendered per platform (SRCH-02)', () => {
  it('renders the mac glyph directly against the key, no separator', () => {
    expect(shortcutLabel('mac', PALETTE_OPEN_SHORTCUT)).toBe('⌘K');
  });

  it('renders the windows word with a separator', () => {
    expect(shortcutLabel('windows', PALETTE_OPEN_SHORTCUT)).toBe('Ctrl+K');
  });

  it('renders any shortcut it is handed, not only the palette\'s own', () => {
    expect(shortcutLabel('mac', { key: 'P' })).toBe('⌘P');
    expect(shortcutLabel('windows', { key: 'P' })).toBe('Ctrl+P');
  });
});
