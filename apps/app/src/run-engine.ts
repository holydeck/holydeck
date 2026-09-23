// A live command is an operator act before it is a frame on a socket. The hub owns transport,
// acknowledgements and retries; this module owns policy: which state a command means, whether it was
// durably recorded, and which views may see it. Mode changes remain the pure contracts reducers; the
// ordering here makes a log failure or a lost compare-and-set stop before anything is published.
// Theme changes take the same path with their own log row (ThemeStore) and reach only the surface they
// theme, plus control (RUN-05). One process runs one live run, matching the hub's
// global channels and counters; a command has no run identifier of its own.

import { LIVE_CHANNELS, LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { enterStandby, pause, resume, returnToLivePosition, select, takeSelectedLive } from '@holydeck/contracts/live-mode';
import { projectFor } from '@holydeck/contracts/live-state';
import { DEFAULT_THEMES, THEME_SURFACES } from '@holydeck/contracts/live-theme';

import { correlationFor, requestContext, systemContext } from './context.js';
import { LIVE_EVENT_TYPES } from './live-events.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { adjacentPosition } from './run-deck.js';
import { RunEventError } from './run-events.js';
import { RUN_PERMISSIONS, RunError, runContext } from './runs.js';

import type { AckOutcome, CommandFrame, LiveChannel } from '@holydeck/contracts/live';
import type { LiveModeState } from '@holydeck/contracts/live-mode';
import type { ChannelState, LivePosition, LiveState } from '@holydeck/contracts/live-state';
import type { Theme, ThemeSurface } from '@holydeck/contracts/live-theme';
import type { RunStartBody } from '@holydeck/contracts/runs';
import type { LiveEventType } from './live-events.js';
import type { LiveHub, LiveMember } from './live-protocol.js';
import type { ThemeChangeResult, ThemeStore } from './live-theme.js';
import type { MidServiceStore } from './mid-service-additions.js';
import type { RunDeck } from './run-deck.js';
import type { RunEventStore } from './run-events.js';
import type { RunRecord, RunStore } from './runs.js';
import type { OperatorSession } from './snapshots.js';

export interface RunEngineOptions {
  readonly hub: Pick<LiveHub, 'publishChange' | 'seedStateRevision' | 'seedStates' | 'stateRevision'>;
  readonly runs: RunStore;
  readonly runEvents: RunEventStore;
  readonly themes: ThemeStore;
  readonly midService: MidServiceStore;
  /** Derives the run's deck and original manifest pins without exposing raw stores to the engine. */
  readonly deck: (context: unknown, run: RunRecord) => Promise<RunDeck>;
  readonly clock: () => string;
}

export interface RunEngine {
  start(session: OperatorSession, request: RunStartBody): Promise<RunRecord>;
  end(session: OperatorSession, runId: string): Promise<RunRecord | undefined>;
  command(member: LiveMember, frame: CommandFrame): Promise<{ readonly outcome: AckOutcome; readonly conflictCode?: string }>;
  /** The HTTP door onto a theme change: the same log, persist and publish path a `theme` command takes.
   *  Refuses with a `RunError` — `state` for a run that is not the active one presented here, `conflict`
   *  when the run moved while the change was being made. */
  changeTheme(session: OperatorSession, runId: string, surface: ThemeSurface, theme: Theme): Promise<ThemeChangeResult>;
  state(runId: string): LiveState | undefined;
  restore(): Promise<void>;
}

const EMPTY_SCREEN: LivePosition = { itemId: '', slideIndex: 0 };

// The generic mode model always holds a position. The persisted/wire model distinguishes a standby
// screen from a slide, so translate its screen identifier into a synthetic position only for reducers.
const toModeState = (live: LiveState): LiveModeState<LivePosition> => ({
  mode: live.mode,
  publicPosition: 'standby' in live.public ? { itemId: live.public.standby, slideIndex: 0 } : live.public,
  selectedPosition: live.selected,
  emptyScreen: EMPTY_SCREEN,
});

const fromModeState = (base: LiveState, next: LiveModeState<LivePosition>): LiveState => ({
  ...base,
  mode: next.mode,
  public: next.mode === 'standby' ? { standby: next.publicPosition.itemId } : next.publicPosition,
  selected: next.selectedPosition,
});

type Command =
  | { readonly type: 'go-to' | 'select'; readonly position: LivePosition }
  | { readonly type: 'next' | 'previous' | 'pause' | 'take-selected' | 'return-to-live' | 'resume-live' }
  | { readonly type: 'standby'; readonly screenId: string }
  | { readonly type: 'theme'; readonly surface: ThemeSurface; readonly theme: Theme };

const commandFrom = (frame: CommandFrame): Command | undefined => {
  const args = typeof frame.args === 'object' && frame.args !== null && !Array.isArray(frame.args)
    ? frame.args as Record<string, unknown> : {};
  const { type } = frame;
  switch (type) {
    case 'go-to':
    case 'select': {
      const { itemId, slideIndex } = args;
      return typeof itemId === 'string' && typeof slideIndex === 'number' && Number.isInteger(slideIndex) && slideIndex >= 0
        ? { type, position: { itemId, slideIndex } } : undefined;
    }
    case 'standby':
      return typeof args['screenId'] === 'string' && args['screenId'].trim() !== ''
        ? { type, screenId: args['screenId'] } : undefined;
    case 'theme': {
      const { surface, themeId } = args;
      if (!THEME_SURFACES.includes(surface as ThemeSurface) || typeof themeId !== 'string' || themeId.trim() === '') return undefined;
      // The shipped defaults are the existing catalogue; unknown IDs never invent a theme.
      const theme = Object.values(DEFAULT_THEMES).find((candidate) => candidate.id === themeId);
      return theme === undefined ? undefined : { type, surface: surface as ThemeSurface, theme };
    }
    case 'next':
    case 'previous':
    case 'pause':
    case 'take-selected':
    case 'return-to-live':
    case 'resume-live':
      return { type };
    default:
      return undefined;
  }
};

const reduce = (command: Exclude<Command, { type: 'theme' }>, mode: LiveModeState<LivePosition>, deck: RunDeck): LiveModeState<LivePosition> | undefined => {
  switch (command.type) {
    case 'go-to':
    case 'select': return select(mode, command.position);
    case 'next':
    case 'previous': {
      const position = adjacentPosition(deck, mode.selectedPosition, command.type);
      return position === undefined ? undefined : select(mode, position);
    }
    case 'standby': {
      const item = deck.items.find((candidate) => candidate.itemId === mode.selectedPosition.itemId);
      const available = item?.standbyScreens?.some((screen) => screen.slideId === command.screenId) ?? false;
      return enterStandby(mode, { itemId: command.screenId, slideIndex: 0 }, available);
    }
    case 'pause': return pause(mode);
    case 'take-selected': return takeSelectedLive(mode);
    case 'return-to-live': return returnToLivePosition(mode);
    case 'resume-live': return resume(mode);
  }
};

const kindFor = (type: Command['type']): LiveEventType => {
  if (type === 'go-to' || type === 'select' || type === 'next' || type === 'previous') return LIVE_EVENT_TYPES.slide;
  return type === 'standby' ? LIVE_EVENT_TYPES.standby : LIVE_EVENT_TYPES.runState;
};

const samePosition = (a: LiveState['public'], b: LiveState['public']): boolean =>
  'standby' in a ? 'standby' in b && a.standby === b.standby
    : !('standby' in b) && a.itemId === b.itemId && a.slideIndex === b.slideIndex;

export function runEngineOn(options: RunEngineOptions): RunEngine {
  const states = new Map<string, LiveState>();
  let currentRunId: string | undefined;

  /** Each channel's privacy projection of `live` (Design §2), computed here so no view is ever sent a
   *  wider view's state to project for itself. */
  const statesFor = (live: LiveState, deck: RunDeck | undefined, channels: readonly LiveChannel[]): Partial<Record<LiveChannel, ChannelState>> => {
    const upcoming = deck === undefined || 'standby' in live.public ? undefined : adjacentPosition(deck, live.public, 'next');
    const states: Partial<Record<LiveChannel, ChannelState>> = {};
    for (const channel of channels) {
      const state = projectFor(
        channel === LIVE_CONTROL_CHANNEL ? 'control' : channel,
        live,
        channel === LIVE_CONTROL_CHANNEL ? { counts: {} } : { next: upcoming },
      );
      if (state !== undefined) states[channel] = state;
    }
    return states;
  };

  /** The revision the next persisted write lands at: always the hub's next one, so the revision a client
   *  sees and the one the run row holds are one number, before and after a restart (RUN-01, Design §4). */
  const nextRevision = (): number => options.hub.stateRevision() + 1;

  /** One landed change per command, however many channels it reaches. A change with nothing public or
   *  private to say still lands, because the persisted revision it matches has moved. */
  const publish = (before: LiveState, next: LiveState, deck: RunDeck, kind: LiveEventType, stateRevision: number): void => {
    const publicChanged = !samePosition(before.public, next.public);
    const privateChanged = before.mode !== next.mode || !samePosition(before.selected, next.selected);
    const channels: readonly LiveChannel[] = publicChanged ? LIVE_CHANNELS
      : privateChanged ? ['stage', LIVE_CONTROL_CHANNEL] : [];
    options.hub.publishChange({ type: kind, states: statesFor(next, deck, channels), stateRevision });
  };

  const channelOf = (surface: ThemeSurface): LiveChannel => surface === 'operator' ? LIVE_CONTROL_CHANNEL : surface;

  /** Logs, persists and publishes one theme change. The theme is part of the run's `LiveState`, so it is
   *  compare-and-set like a position and survives both the next command and a restart. */
  const retheme = async (
    session: OperatorSession, run: RunRecord, deck: RunDeck, surface: ThemeSurface, theme: Theme,
  ): Promise<ThemeChangeResult | 'stale'> => {
    const recorded = await options.themes.changeTheme(session, {
      runId: run.runId, surface, theme, pinnedRevisions: deck.pinnedRevisions,
    });
    const next: LiveState = { ...run.live, themes: { ...run.live.themes, [surface]: theme.id } };
    const context = runContext(session.actor, session.correlationId);
    const advanced = await options.runs.advance(context, run.runId, run.stateRevision, next, nextRevision());
    if (advanced === 'stale') return 'stale';
    if (advanced === undefined) throw new RunError('state', `${run.runId} is no longer a run this server knows`);
    states.set(run.runId, next);
    const channels = [...new Set<LiveChannel>([channelOf(surface), LIVE_CONTROL_CHANNEL])];
    const landed = options.hub.publishChange({ type: LIVE_EVENT_TYPES.theme, states: statesFor(next, deck, channels), stateRevision: advanced.stateRevision });
    return { ...recorded, landed };
  };

  const apply: RunEngine['command'] = async (member, frame) => {
    if (!member.grant.command) return { outcome: 'unauthorized' };
    if (currentRunId === undefined) return { outcome: 'failed' };
    // Validate before any store read as well as before writes: a malformed command has no run work.
    const command = commandFrom(frame);
    if (command === undefined) return { outcome: 'invalid' };
    const runId = currentRunId;
    const session: OperatorSession = {
      actor: member.identity ?? 'live-control',
      permissions: [PRESENTATION_CONTROL],
      // A member's identity and a client-chosen frame id are both unbounded in practice; `correlationFor`
      // is the same guard every other route builds one through, so a long real-world identity plus a
      // client's own id can never overflow `context.ts`'s 64-character limit and crash the command path.
      correlationId: correlationFor('live:', `${member.identity ?? 'anonymous'}:${frame.id}`),
    };
    const context = runContext(session.actor, session.correlationId);
    const run = await options.runs.resume(context, runId);
    // An ended run is history, not a screen: nothing more is logged against it or shown from it.
    if (run === undefined || run.phase !== 'active') return { outcome: 'failed' };
    const deck = await options.deck(context, run);
    if (command.type === 'theme') {
      try {
        return { outcome: await retheme(session, run, deck, command.surface, command.theme) === 'stale' ? 'stale' : 'applied' };
      } catch (error) {
        return { outcome: error instanceof RunEventError && (error.kind === 'schema' || error.kind === 'permission') ? 'invalid' : 'failed' };
      }
    }
    const nextMode = reduce(command, toModeState(run.live), deck);
    if (nextMode === undefined) return { outcome: 'invalid' };
    const next = fromModeState(run.live, nextMode);
    const kind = kindFor(command.type);
    await options.runEvents.record(session, {
      runId, kind, pinnedRevisions: deck.pinnedRevisions,
      ...(kind === LIVE_EVENT_TYPES.slide ? {
        shown: {
          itemId: next.selected.itemId,
          reference: deck.items.find((item) => item.itemId === next.selected.itemId)?.title ?? next.selected.itemId,
        },
      } : {}),
    });
    const advanced = await options.runs.advance(context, runId, run.stateRevision, next, nextRevision());
    if (advanced === 'stale') return { outcome: 'stale' };
    if (advanced === undefined) return { outcome: 'failed' };
    states.set(runId, next);
    publish(run.live, next, deck, kind, advanced.stateRevision);
    return { outcome: 'applied' };
  };

  const engine: RunEngine = {
    start: async (session, request) => {
      const record = await options.runs.start(session, request, nextRevision());
      const deck = await options.deck(runContext(session.actor, session.correlationId), record);
      currentRunId = record.runId;
      states.set(record.runId, record.live);
      options.hub.publishChange({
        type: LIVE_EVENT_TYPES.runState, states: statesFor(record.live, deck, LIVE_CHANNELS), everyone: true, stateRevision: record.stateRevision,
      });
      return record;
    },
    end: async (session, runId) => {
      const record = await options.runs.end(session, runId, nextRevision());
      if (record !== undefined) {
        states.set(runId, record.live);
        if (currentRunId === runId) currentRunId = undefined;
        // Every view is told, and none keeps showing the run that ended.
        options.hub.publishChange({ type: LIVE_EVENT_TYPES.runState, states: {}, everyone: true, stateRevision: record.stateRevision });
      }
      return record;
    },
    command: async (member, frame) => {
      // Any store read, deck derivation or write below may throw (a transient Mongo error, a snapshot
      // missing a pinned revision). None of those is the client's fault and none of them may escape: the
      // hub runs commands detached from the socket, so an escaped rejection would end the whole process.
      try {
        return await apply(member, frame);
      } catch {
        return { outcome: 'failed' };
      }
    },
    changeTheme: async (session, runId, surface, theme) => {
      const context = runContext(session.actor, session.correlationId);
      const run = runId === currentRunId ? await options.runs.resume(context, runId) : undefined;
      if (run === undefined || run.phase !== 'active') {
        throw new RunError('state', `${runId} is not the active run this server is presenting`);
      }
      const deck = await options.deck(context, run);
      const result = await retheme(session, run, deck, surface, theme);
      if (result === 'stale') throw new RunError('conflict', `${runId} moved while its theme was being changed`);
      return result;
    },
    state: (runId) => states.get(runId),
    restore: async () => {
      const system = systemContext('boot:run-engine');
      const context = requestContext({ ...system, permissions: [...system.permissions, RUN_PERMISSIONS.read] });
      // Every run, ended ones included: the revision a restarted hub starts from is the highest ever
      // persisted, so it never falls below one a client was already sent (RUN-01).
      const all = await options.runs.list(context);
      if (all.length === 0) return;
      options.hub.seedStateRevision(Math.max(...all.map((run) => run.stateRevision)));
      const active = all.filter((run) => run.phase === 'active');
      for (const run of active) states.set(run.runId, run.live);
      // `list` answers most recently started first; that is the run this process was presenting.
      const [current] = active;
      if (current === undefined) return;
      currentRunId = current.runId;
      let deck: RunDeck | undefined;
      try {
        deck = await options.deck(context, current);
      } catch {
        // Without a deck the first snapshot still carries position, mode and theme; only `next` is missing.
        deck = undefined;
      }
      options.hub.seedStates(statesFor(current.live, deck, LIVE_CHANNELS));
    },
  };
  return Object.freeze(engine);
}
