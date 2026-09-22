import { beforeEach, describe, expect, it } from 'vitest';

import { can, csrf, locale, onboarding, resetAppState, session, updateRequired } from './app-state.js';

import type { SessionView } from '@holydeck/contracts/sessions';

const VIEW: SessionView = {
  actor: 'account:GLkQ5wEtQEy5PfN2Zr9m7A',
  permissions: ['services.read'],
  startedAt: '2026-09-13T09:30:00.000Z',
  lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z',
  rotation: 'authentication',
  csrf: 'a'.repeat(43),
  slots: [],
};

beforeEach(resetAppState);

describe('application state', () => {
  it('keeps the session token and permission questions derived from the verified session', () => {
    expect(csrf()).toBeUndefined();
    expect(can('services.read')).toBe(false);

    session.value = VIEW;
    expect(csrf()).toBe(VIEW.csrf);
    expect(can('services.read')).toBe(true);
    expect(can('services.write')).toBe(false);
  });

  it('restores every memory-only value to its fresh-load state', () => {
    session.value = null;
    onboarding.value = 'claimed';
    locale.value = 'de';
    updateRequired.value = true;

    resetAppState();

    expect(session.value).toBeUndefined();
    expect(onboarding.value).toBeUndefined();
    expect(updateRequired.value).toBe(false);
  });
});
