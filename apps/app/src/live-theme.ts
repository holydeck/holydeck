// Composes `@holydeck/contracts/live-theme`'s pure per-surface model onto a live run: the one place a theme
// change actually becomes the two things LIVE-09 says it must — a versioned event every joined session on
// every channel is pushed (`live-events.ts`'s `publishThemeChanged`), and an immutable row in this run's
// own event log (`run-events.ts`, LIVE-12). The contracts module itself has neither a hub nor a store to
// reach either of those with; this module is exactly the difference.
//
// `runEvents.record` is called first, deliberately, and `publishThemeChanged` only after it resolves: THR-11
// (checked first inside `record`, before a single read or write) is what decides whether a theme change
// happened at all. Publishing before that check could land a `theme-changed` event on every watching view
// for a change the run's own log then refused to keep — a partial act this ordering makes impossible.
//
// State here is held in memory, per run, the way `LiveHub` itself holds state per hub: a surface's current
// theme is what a live session is presenting right now, not a row `snapshots.ts`'s seven pins would ever
// need to reproduce a run from. What is durable is the log entry `runEvents.record` appends — the theme
// itself is exactly as reproducible as any other operator act LIVE-12 already logs.

import {
  DEFAULT_THEMES,
  setSurfaceTheme,
} from '@holydeck/contracts/live-theme';

import { LIVE_EVENT_TYPES, publishThemeChanged } from './live-events.js';

import type { SnapshotPin } from '@holydeck/contracts/snapshots';
import type { SurfaceThemeState, Theme, ThemeSurface } from '@holydeck/contracts/live-theme';
import type { Landed, LiveHub } from './live-protocol.js';
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

export interface ThemeChangeResult {
  /** Every surface's theme for this run after the change — only `input.surface` moved. */
  readonly state: SurfaceThemeState<PinnedRevisions>;
  /** The immutable row this change appended to the run's own event log. */
  readonly event: RunEventRecord;
  /** Where the hub's own state revision and sequence landed after this change was published. */
  readonly landed: Landed;
}

export interface ThemeStore {
  /** Moves one surface's theme for a run in progress: appends the run event first (THR-11, pin
   *  validation — refused before this ever reaches the hub), then publishes the versioned event every
   *  joined session, on every channel, is pushed. */
  changeTheme(session: OperatorSession, input: ChangeThemeInput): Promise<ThemeChangeResult>;
  /** Every surface's theme for a run right now, or `undefined` for a run no theme has ever been changed
   *  on — which is not the same as a run showing nothing: `DEFAULT_THEMES` is what it is showing. */
  themesFor(runId: string): SurfaceThemeState<PinnedRevisions> | undefined;
}

export function themesOn(hub: Pick<LiveHub, 'publish'>, runEvents: Pick<RunEventStore, 'record'>): ThemeStore {
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

      const landed = publishThemeChanged(hub);
      return { state, event, landed };
    },

    themesFor: (runId) => states.get(runId),
  };
  return Object.freeze(store);
}
