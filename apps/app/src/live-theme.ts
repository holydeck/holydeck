// Composes `@holydeck/contracts/live-theme`'s pure per-surface model onto a live run's event log: a theme
// change is an immutable row in this run's own log (`run-events.ts`, LIVE-12) before it is anything else.
// It is deliberately not the whole of a theme change. The run engine (`run-engine.ts`) calls this first,
// then persists the new theme into the run's `LiveState` and publishes it only to the surface it concerns
// (RUN-05): a Stage theme is never an Audience frame, and a theme survives the next slide and a restart
// because it lives in the run row, not only here.
//
// `runEvents.record` is called first, deliberately: THR-11 (checked first inside `record`, before a single
// read or write) is what decides whether a theme change happened at all, so nothing is persisted or
// published for a change the run's own log refused to keep.
//
// The per-surface theme objects are held in memory, per run: what the run row keeps is each surface's
// theme id, which is what every view is projected from.

import {
  DEFAULT_THEMES,
  setSurfaceTheme,
} from '@holydeck/contracts/live-theme';

import { LIVE_EVENT_TYPES } from './live-events.js';

import type { SnapshotPin } from '@holydeck/contracts/snapshots';
import type { SurfaceThemeState, Theme, ThemeSurface } from '@holydeck/contracts/live-theme';
import type { Landed } from './live-protocol.js';
import type { RunEventRecord, RunEventStore } from './run-events.js';
import type { OperatorSession } from './snapshots.js';

/** The prepared content a theme change is proven never to move: every one of `SNAPSHOT_PINS`, exactly as
 *  `run-events.ts`'s own `RunEventInput` already requires them. */
export type PinnedRevisions = Readonly<Record<SnapshotPin, string>>;

export interface ChangeThemeInput {
  readonly runId: string;
  readonly surface: ThemeSurface;
  readonly theme: Theme;
  readonly pinnedRevisions: PinnedRevisions;
}

export interface ThemeRecorded {
  /** Every surface's theme for this run after the change — only `input.surface` moved. */
  readonly state: SurfaceThemeState<PinnedRevisions>;
  /** The immutable row this change appended to the run's own event log. */
  readonly event: RunEventRecord;
}

export interface ThemeChangeResult extends ThemeRecorded {
  /** Where the hub's own state revision and sequence landed after the run engine published the change. */
  readonly landed: Landed;
}

export interface ThemeStore {
  /** Records one surface's theme change for a run in progress: appends the run event (THR-11, pin
   *  validation), then moves this run's in-memory theme state. Publishes nothing; the engine does. */
  changeTheme(session: OperatorSession, input: ChangeThemeInput): Promise<ThemeRecorded>;
  /** Every surface's theme for a run right now, or `undefined` for a run no theme has ever been changed
   *  on — which is not the same as a run showing nothing: `DEFAULT_THEMES` is what it is showing. */
  themesFor(runId: string): SurfaceThemeState<PinnedRevisions> | undefined;
}

export function themesOn(runEvents: Pick<RunEventStore, 'record'>): ThemeStore {
  const states = new Map<string, SurfaceThemeState<PinnedRevisions>>();

  const store: ThemeStore = {
    changeTheme: async (session, input) => {
      const event = await runEvents.record(session, {
        runId: input.runId,
        kind: LIVE_EVENT_TYPES.theme,
        pinnedRevisions: input.pinnedRevisions,
      });

      const before = states.get(input.runId) ?? {
        content: input.pinnedRevisions,
        themes: DEFAULT_THEMES,
        version: 0,
      };
      const state = setSurfaceTheme(before, input.surface, input.theme);
      states.set(input.runId, state);

      return { state, event };
    },

    themesFor: (runId) => states.get(runId),
  };
  return Object.freeze(store);
}
