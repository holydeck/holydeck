import type { LiveMode } from './live-mode.js';
import type { ThemeSurface } from './live-theme.js';

// This pure projection is tested exhaustively here because it is the one place privacy is enforced on
// the wire (D4, Design §2): each public view must contain only the fields its viewer may receive.

export type LivePosition = { readonly itemId: string; readonly slideIndex: number };

export type LiveState = {
  readonly runId: string;
  readonly snapshotId: string;
  readonly mode: LiveMode;
  readonly public: LivePosition | { readonly standby: string };
  readonly selected: LivePosition;
  readonly themes: Readonly<Record<'control' | Exclude<ThemeSurface, 'operator'>, string>> &
    Readonly<Partial<Record<'operator', string>>>;
  readonly additionsRevision: number;
};

export type ChannelState =
  | {
      readonly view: 'audience';
      readonly runId: string;
      readonly snapshotId: string;
      readonly frame: LivePosition | { readonly standby: string };
      readonly themeId: string;
      readonly additionsRevision: number;
      readonly announcement?: string;
    }
  | {
      readonly view: 'singer';
      readonly runId: string;
      readonly snapshotId: string;
      readonly frame: LivePosition | { readonly standby: string };
      readonly themeId: string;
      readonly additionsRevision: number;
      readonly next?: LivePosition;
      readonly announcement?: string;
    }
  | {
      readonly view: 'stage';
      readonly runId: string;
      readonly snapshotId: string;
      readonly frame: LivePosition | { readonly standby: string };
      readonly themeId: string;
      readonly additionsRevision: number;
      readonly next?: LivePosition;
      readonly announcement?: string;
      readonly selected?: LivePosition;
      readonly mode: LiveMode;
    }
  | { readonly view: 'control'; readonly state: LiveState; readonly counts: Readonly<Record<string, number>> };

export function projectFor(
  view: ChannelState['view'],
  state: LiveState,
  extra: { readonly next?: LivePosition; readonly announcement?: string; readonly counts?: Readonly<Record<string, number>> } = {},
): ChannelState {
  if (view === 'control') return { view, state, counts: extra.counts ?? {} };

  const base = {
    runId: state.runId,
    snapshotId: state.snapshotId,
    frame: state.public,
    themeId: state.themes[view],
    additionsRevision: state.additionsRevision,
    ...(extra.announcement === undefined ? {} : { announcement: extra.announcement }),
  };
  if (view === 'audience') return { view, ...base };
  if (view === 'singer') return { view, ...base, ...(extra.next === undefined ? {} : { next: extra.next }) };
  return {
    view,
    ...base,
    ...(extra.next === undefined ? {} : { next: extra.next }),
    mode: state.mode,
  };
}
