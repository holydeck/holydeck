import { describe, expect, it } from 'vitest';

import { parseWorkspacePosition } from './workspace.js';

describe('parseWorkspacePosition', () => {
  it('accepts an empty position and a full one', () => {
    expect(parseWorkspacePosition({})).toEqual({ ok: true, value: {} });
    const full = { serviceId: 's1', itemId: 'i1', slideId: 'sl1', contentId: 'c1' };
    expect(parseWorkspacePosition(full)).toEqual({ ok: true, value: full });
  });

  it('refuses an item or slide with no service to hold it', () => {
    const parsed = parseWorkspacePosition({ itemId: 'i1' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems[0]).toMatchObject({ path: 'position.itemId', code: 'field.not_allowed' });
  });

  it('refuses a slide with neither an item nor a content record', () => {
    const parsed = parseWorkspacePosition({ serviceId: 's1', slideId: 'sl1' });
    expect(parsed.ok).toBe(false);
  });

  it('refuses an empty identifier', () => {
    expect(parseWorkspacePosition({ serviceId: '' }).ok).toBe(false);
  });
});
