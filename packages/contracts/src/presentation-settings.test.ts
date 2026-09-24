import { describe, expect, it } from 'vitest';

import { DEFAULT_TRANSITION, TRANSITIONS, parsePresentationSettings } from './presentation-settings.js';
import { FIELD_CODES } from './problems.js';

// Mirrors apps/web/src/presentation-transitions.ts's own `TRANSITIONS` — duplicated rather than imported,
// because a contracts package a server also depends on must never import from an app. Keeping the two
// lists as separate value literals, compared here, is what actually guards against the two drifting apart
// unnoticed, until a later Web task refactors that module to import `TransitionName` from here instead.
const WEB_TRANSITIONS = ['none', 'fade', 'crossfade', 'push'] as const;

describe('the presentation settings a deployment configures (OUT-03)', () => {
  it('names the same transitions apps/web/src/presentation-transitions.ts offers', () => {
    expect(TRANSITIONS).toEqual(WEB_TRANSITIONS);
  });

  it('defaults to none, the hard cut every deployment can afford', () => {
    expect(DEFAULT_TRANSITION).toBe('none');
  });

  it('round-trips every transition through the settings parser', () => {
    for (const transition of TRANSITIONS) {
      expect(parsePresentationSettings({ transition })).toEqual({ ok: true, value: { transition } });
    }
  });

  it('refuses a transition this build does not offer', () => {
    const parsed = parsePresentationSettings({ transition: 'wipe' });
    expect(parsed).toEqual({
      ok: false,
      problems: [
        { path: 'presentation.transition', code: FIELD_CODES.notAllowed, message: `must be one of ${TRANSITIONS.join(', ')}` },
      ],
    });
  });

  it('requires a transition, rather than silently keeping whatever was configured before', () => {
    const parsed = parsePresentationSettings({});
    expect(parsed).toEqual({
      ok: false,
      problems: [{ path: 'presentation.transition', code: FIELD_CODES.required, message: 'is required' }],
    });
  });
});
