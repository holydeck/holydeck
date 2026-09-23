import { DEFAULT_THEMES, THEME_SURFACES } from '@holydeck/contracts/live-theme';
import { describe, expect, it } from 'vitest';

import { themesOn } from './live-theme.js';
import { RunEventError, runEventContext, runEventsOn } from './run-events.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { Theme, ThemeSurface } from '@holydeck/contracts/live-theme';
import type { OperatorSession } from './snapshots.js';

const START = Date.parse('2026-09-19T10:00:00.000Z');
const OPERATOR = `account:${'D'.repeat(22)}`;
const CORRELATION = 'req-live-theme-1';
const RUN_ID = 'run-1';

const SESSION: OperatorSession = { actor: OPERATOR, permissions: ['presentation.control'], correlationId: CORRELATION };
const UNAUTHORIZED: OperatorSession = { actor: 'account:viewer', permissions: [], correlationId: 'req-viewer-1' };

const PINS_ONE = Object.freeze({
  service: 'service@1',
  content: 'content@1',
  slideLayout: 'layout@1',
  serviceTemplate: 'template@1',
  settings: 'settings@1',
  media: 'media@1',
  corpus: 'corpus@1',
});

const harness = () => {
  const db = fakeDb();
  let tick = 0;
  const now = (): string => new Date(START + (tick += 1) * 1000).toISOString();
  const runEvents = runEventsOn(db, { now });
  const store = themesOn(runEvents);
  return { db, runEvents, store };
};

describe('per-surface themes differ independently over identical prepared content (LIVE-09)', () => {
  it('moves one surface, leaving the other three at their default and the pinned content exactly as it was', async () => {
    const { store } = harness();

    const { state } = await store.changeTheme(SESSION, {
      runId: RUN_ID,
      surface: 'stage',
      theme: DEFAULT_THEMES.stage,
      pinnedRevisions: PINS_ONE,
    });

    expect(state.themes.stage).toEqual(DEFAULT_THEMES.stage);
    expect(state.themes.audience).toEqual(DEFAULT_THEMES.audience);
    expect(state.themes.singer).toEqual(DEFAULT_THEMES.singer);
    expect(state.themes.operator).toEqual(DEFAULT_THEMES.operator);
    // The exact same reference handed in, not a copy that merely reads equal — a theme change never
    // rebuilds, and so never could quietly alter, the prepared content it was called alongside.
    expect(state.content).toBe(PINS_ONE);
  });

  it('reaches all four surfaces independently: four separate changes never leave one behind or touch the content', async () => {
    const { store } = harness();
    const customOf = (surface: ThemeSurface): Theme => ({
      id: `${surface}-custom`,
      background: '#000000',
      foreground: '#ffffff',
      accent: '#00ff00',
    });

    let last;
    for (const surface of THEME_SURFACES) {
      last = await store.changeTheme(SESSION, { runId: RUN_ID, surface, theme: customOf(surface), pinnedRevisions: PINS_ONE });
    }

    for (const surface of THEME_SURFACES) expect(last!.state.themes[surface]).toEqual(customOf(surface));
    expect(last!.state.content).toBe(PINS_ONE);
  });

  it('reports no theme state for a run nothing has changed the theme of yet', () => {
    const { store } = harness();
    expect(store.themesFor(RUN_ID)).toBeUndefined();
  });
});

describe('a theme change during a run is logged (LIVE-12)', () => {
  it('appends one immutable run event per change, in order, each carrying the pinned revisions byte-unchanged', async () => {
    const { store, runEvents } = harness();

    await store.changeTheme(SESSION, { runId: RUN_ID, surface: 'audience', theme: DEFAULT_THEMES.audience, pinnedRevisions: PINS_ONE });
    await store.changeTheme(SESSION, { runId: RUN_ID, surface: 'stage', theme: DEFAULT_THEMES.stage, pinnedRevisions: PINS_ONE });

    const log = await runEvents.log(runEventContext(OPERATOR, CORRELATION), RUN_ID);
    expect(log.map((event) => event.kind)).toEqual(['theme-changed', 'theme-changed']);
    expect(log.map((event) => event.sequence)).toEqual([1, 2]);
    expect(log.map((event) => event.pinnedRevisions)).toEqual([PINS_ONE, PINS_ONE]);
  });
});

describe('an unauthorized session', () => {
  it('is refused before the run event log or any watching view is touched — theming is never a partial act', async () => {
    const { store, runEvents } = harness();

    await expect(
      store.changeTheme(UNAUTHORIZED, { runId: RUN_ID, surface: 'audience', theme: DEFAULT_THEMES.audience, pinnedRevisions: PINS_ONE }),
    ).rejects.toBeInstanceOf(RunEventError);

    expect(await runEvents.log(runEventContext(OPERATOR, CORRELATION), RUN_ID)).toHaveLength(0);
    expect(store.themesFor(RUN_ID)).toBeUndefined();
  });
});
