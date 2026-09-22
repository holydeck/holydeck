// A live command is an operator act before it is a frame on a socket. The hub owns transport,
// acknowledgements and retries; this module owns policy: which state a command means, whether it was
// durably recorded, and which views may see it. Mode changes remain the pure contracts reducers; the
// ordering here makes a log failure or a lost compare-and-set stop before anything is published.
// Theme commands are the exception: ThemeStore owns their log and broadcast, so they never enter the
// position pipeline or publish a second event here. One process runs one live run, matching the hub's
// global channels and counters; a command has no run identifier of its own.

import { LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { enterStandby, pause, resume, returnToLivePosition, select, takeSelectedLive } from '@holydeck/contracts/live-mode';
import { projectFor } from '@holydeck/contracts/live-state';
import { DEFAULT_THEMES, THEME_SURFACES } from '@holydeck/contracts/live-theme';

import { requestContext, systemContext } from './context.js';
import { LIVE_EVENT_TYPES, publishRunStateChanged } from './live-events.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { adjacentPosition } from './run-deck.js';
import { RunEventError } from './run-events.js';
import { RUN_PERMISSIONS, runContext } from './runs.js';

import type { AckOutcome, CommandFrame, LiveChannel } from '@holydeck/contracts/live';
import type { LiveModeState } from '@holydeck/contracts/live-mode';
import type { LivePosition, LiveState } from '@holydeck/contracts/live-state';
import type { Theme, ThemeSurface } from '@holydeck/contracts/live-theme';
import type { RunStartBody } from '@holydeck/contracts/runs';
import type { LiveEventType } from './live-events.js';
import type { LiveHub, LiveMember } from './live-protocol.js';
import type { ThemeStore } from './live-theme.js';
import type { MidServiceStore } from './mid-service-additions.js';
import type { RunDeck } from './run-deck.js';
import type { RunEventStore } from './run-events.js';
import type { RunRecord, RunStore } from './runs.js';
import type { OperatorSession } from './snapshots.js';

export interface RunEngineOptions {
  readonly hub: Pick<LiveHub, 'publishTo' | 'publish' | 'seedStateRevision'>;
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

  const publish = (before: LiveState, next: LiveState, deck: RunDeck, kind: LiveEventType): void => {
    const publicChanged = !samePosition(before.public, next.public);
    const privateChanged = before.mode !== next.mode || !samePosition(before.selected, next.selected);
    const channels: readonly LiveChannel[] = publicChanged ? ['audience', 'singer', 'stage', LIVE_CONTROL_CHANNEL]
      : privateChanged ? ['stage', LIVE_CONTROL_CHANNEL] : [];
    const upcoming = 'standby' in next.public ? undefined : adjacentPosition(deck, next.public, 'next');
    for (const channel of channels) {
      options.hub.publishTo(channel, kind, (view) => projectFor(
        view === LIVE_CONTROL_CHANNEL ? 'control' : view,
        next,
        view === LIVE_CONTROL_CHANNEL ? { counts: {} } : { next: upcoming },
      ));
    }
  };

  const engine: RunEngine = {
    start: async (session, request) => {
      const record = await options.runs.start(session, request);
      currentRunId = record.runId;
      states.set(record.runId, record.live);
      publishRunStateChanged(options.hub);
      await options.deck(runContext(session.actor, session.correlationId), record);
      return record;
    },
    end: async (session, runId) => {
      const record = await options.runs.end(session, runId);
      if (record !== undefined) {
        states.set(runId, record.live);
        publishRunStateChanged(options.hub);
      }
      return record;
    },
    command: async (member, frame) => {
      if (!member.grant.command) return { outcome: 'unauthorized' };
      if (currentRunId === undefined) return { outcome: 'failed' };
      // Validate before any store read as well as before writes: a malformed command has no run work.
      const command = commandFrom(frame);
      if (command === undefined) return { outcome: 'invalid' };
      const runId = currentRunId;
      const session: OperatorSession = {
        actor: member.identity ?? 'live-control',
        permissions: [PRESENTATION_CONTROL],
        correlationId: `live:${member.identity ?? 'anonymous'}:${frame.id}`,
      };
      const context = runContext(session.actor, session.correlationId);
      const run = await options.runs.resume(context, runId);
      if (run === undefined) return { outcome: 'failed' };
      const deck = await options.deck(context, run);
      if (command.type === 'theme') {
        try {
          await options.themes.changeTheme(session, {
            runId, surface: command.surface, theme: command.theme, pinnedRevisions: deck.pinnedRevisions,
          });
          states.set(runId, { ...run.live, themes: { ...run.live.themes, [command.surface]: command.theme.id } });
          return { outcome: 'applied' };
        } catch (error) {
          return { outcome: error instanceof RunEventError && (error.kind === 'schema' || error.kind === 'permission') ? 'invalid' : 'failed' };
        }
      }
      const nextMode = reduce(command, toModeState(run.live), deck);
      if (nextMode === undefined) return { outcome: 'invalid' };
      const next = fromModeState(run.live, nextMode);
      const kind = kindFor(command.type);
      try {
        await options.runEvents.record(session, {
          runId, kind, pinnedRevisions: deck.pinnedRevisions,
          ...(kind === LIVE_EVENT_TYPES.slide ? {
            shown: {
              itemId: next.selected.itemId,
              reference: deck.items.find((item) => item.itemId === next.selected.itemId)?.title ?? next.selected.itemId,
            },
          } : {}),
        });
      } catch {
        return { outcome: 'failed' };
      }
      const advanced = await options.runs.advance(context, runId, run.stateRevision, next);
      if (advanced === 'stale') return { outcome: 'stale' };
      if (advanced === undefined) return { outcome: 'failed' };
      states.set(runId, next);
      publish(run.live, next, deck, kind);
      return { outcome: 'applied' };
    },
    state: (runId) => states.get(runId),
    restore: async () => {
      const system = systemContext('boot:run-engine');
      const context = requestContext({ ...system, permissions: [...system.permissions, RUN_PERMISSIONS.read] });
      const active = await options.runs.active(context);
      for (const run of active) states.set(run.runId, run.live);
      if (active.length > 0) {
        const highest = active.reduce((a, b) => a.stateRevision >= b.stateRevision ? a : b);
        currentRunId = highest.runId;
        options.hub.seedStateRevision(highest.stateRevision);
      }
    },
  };
  return Object.freeze(engine);
}
