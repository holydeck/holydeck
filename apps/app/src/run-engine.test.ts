import { LIVE_CHANNELS, LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { DEFAULT_THEMES } from '@holydeck/contracts/live-theme';
import { SNAPSHOT_PINS } from '@holydeck/contracts/snapshots';
import { describe, expect, it, vi } from 'vitest';

import { LIVE_EVENT_TYPES } from './live-events.js';
import { grantFor } from './live-protocol.js';
import { PRESENTATION_CONTROL } from './roles.js';
import { RunEventError } from './run-events.js';
import { RunError } from './runs.js';
import { runEngineOn } from './run-engine.js';

import type { CommandFrame, LiveChannel } from '@holydeck/contracts/live';
import type { ChannelState, LiveState } from '@holydeck/contracts/live-state';
import type { SnapshotPin } from '@holydeck/contracts/snapshots';
import type { LiveMember } from './live-protocol.js';
import type { RunEngineOptions } from './run-engine.js';
import type { RunRecord, RunStore } from './runs.js';

const AT = '2026-09-23T09:00:00.000Z';
const SESSION = { actor: 'account:operator', permissions: [PRESENTATION_CONTROL], correlationId: 'test:engine' };
const CONTROL_MEMBER: LiveMember = { channel: LIVE_CONTROL_CHANNEL, grant: grantFor(SESSION.permissions), identity: SESSION.actor };
const PINS = Object.fromEntries(SNAPSHOT_PINS.map((pin) => [pin, `${pin}@1`])) as Record<SnapshotPin, string>;
const FIRST = { itemId: 'item-1', slideIndex: 0 };
const SECOND = { itemId: 'item-2', slideIndex: 0 };
const LIVE: LiveState = {
  runId: 'run-1', snapshotId: 'snapshot-1', mode: 'live', public: FIRST, selected: FIRST,
  themes: { audience: 'audience-default', stage: 'stage-default', singer: 'singer-default', operator: 'operator-default' },
  additionsRevision: 0,
};
const RECORD: RunRecord = {
  runId: 'run-1', serviceId: 'service-1', snapshotId: 'snapshot-1', phase: 'active', mode: 'live',
  position: 0, live: LIVE, stateRevision: 7, at: AT,
};
const frame = (type: string, args?: unknown): CommandFrame => ({
  kind: 'command', channel: LIVE_CONTROL_CHANNEL, id: 'command-1', idempotencyKey: 'key-1',
  clientStateRevision: 7, type, ...(args === undefined ? {} : { args }),
});

const setup = () => {
  let held: RunRecord = RECORD;
  const order: string[] = [];
  const publishToCalls: { channel: LiveChannel; type: string; state: ChannelState | undefined }[] = [];
  const changes: Parameters<RunEngineOptions['hub']['publishChange']>[0][] = [];
  let revision = 7;
  const hub = {
    publishToCalls,
    changes,
    seedStateRevision: vi.fn(),
    seedStates: vi.fn(),
    stateRevision: vi.fn(() => revision),
    // Flattened per channel, so an assertion reads which view was told what.
    publishChange: vi.fn<RunEngineOptions['hub']['publishChange']>((change) => {
      order.push('publish');
      changes.push(change);
      revision = Math.max(revision + 1, change.stateRevision ?? 0);
      for (const [channel, state] of Object.entries(change.states)) {
        publishToCalls.push({ channel: channel as LiveChannel, type: change.type, state });
      }
      return { sequence: 1, stateRevision: revision };
    }),
  };
  const runs = {
    start: vi.fn<RunStore['start']>(async () => held),
    end: vi.fn<RunStore['end']>(async () => ({ ...held, phase: 'ended' })),
    resume: vi.fn<RunStore['resume']>(async () => held),
    active: vi.fn<RunStore['active']>(async () => [held]),
    list: vi.fn<RunStore['list']>(async () => [held]),
    history: vi.fn<RunStore['history']>(async () => [held]),
    advance: vi.fn<RunStore['advance']>(async (_context, _runId, expected, live) => {
      order.push('advance');
      if (held.stateRevision !== expected) return 'stale';
      held = { ...held, live, stateRevision: expected + 1 };
      return held;
    }),
  };
  const runEvents = {
    record: vi.fn<RunEngineOptions['runEvents']['record']>(async (session, input) => {
      order.push('record');
      return { ...input, actor: session.actor, at: AT, sequence: 1 };
    }),
    log: vi.fn(async () => []),
  };
  const themes = {
    changeTheme: vi.fn<RunEngineOptions['themes']['changeTheme']>(async (_session, input) => ({
      state: { content: input.pinnedRevisions, themes: { ...DEFAULT_THEMES, [input.surface]: input.theme }, version: 1 },
      event: { runId: input.runId, kind: LIVE_EVENT_TYPES.theme, pinnedRevisions: input.pinnedRevisions, actor: SESSION.actor, at: AT, sequence: 1 },
      landed: { sequence: 1, stateRevision: 1 },
    })),
    themesFor: vi.fn(() => undefined),
  };
  const midService = { add: vi.fn(), additions: vi.fn(async () => []) };
  const deck = vi.fn(async () => ({
    snapshotId: 'snapshot-1', pinnedRevisions: PINS, aspectRatio: '16:9',
    safeAreaMargins: { top: 0, right: 0, bottom: 0, left: 0, unit: 'percent' as const },
    items: [
      { itemId: 'item-1', title: 'First song', kind: 'song', slides: [{ slideId: 'slide-1', boxes: [] }, { slideId: 'slide-2', boxes: [] }], standbyScreens: [{ slideId: 'welcome', boxes: [] }] },
      { itemId: 'empty', title: 'Addition', kind: 'mid-service', slides: [] },
      { itemId: 'item-2', title: 'Second song', kind: 'song', slides: [{ slideId: 'slide-3', boxes: [] }] },
    ],
  }));
  const engine = runEngineOn({ hub, runs, runEvents, themes, midService, deck, clock: () => AT });
  return { engine, hub, runs, runEvents, themes, midService, deck, order };
};
const started = async () => {
  const built = setup();
  await built.engine.start(SESSION, { serviceId: 'service-1', mode: 'live' });
  built.hub.publishChange.mockClear();
  built.hub.changes.length = 0;
  built.hub.publishToCalls.length = 0;
  built.order.length = 0;
  return built;
};

describe('run-engine command ordering', () => {
  it('advances next/previous across an item boundary', async () => {
    const { engine } = await started();
    for (const [command, position] of [['next', { ...FIRST, slideIndex: 1 }], ['next', SECOND], ['previous', { ...FIRST, slideIndex: 1 }]] as const) {
      expect(await engine.command(CONTROL_MEMBER, frame(command))).toEqual({ outcome: 'applied' });
      expect(engine.state('run-1')?.public).toEqual(position);
    }
  });

  it('standby falls back to the empty screen when media is unavailable', async () => {
    const { engine } = await started();
    await engine.command(CONTROL_MEMBER, frame('standby', { screenId: 'missing' }));
    expect(engine.state('run-1')).toMatchObject({ mode: 'standby', public: { standby: '' }, selected: FIRST });
  });

  it('pause then select moves only the selected position and publishes no audience event', async () => {
    const { engine, hub } = await started();
    await engine.command(CONTROL_MEMBER, frame('pause'));
    for (let i = 0; i < 30; i += 1) {
      await engine.command(CONTROL_MEMBER, frame('select', i % 2 === 0 ? SECOND : FIRST));
      expect(engine.state('run-1')?.public).toEqual(FIRST);
    }
    expect(hub.publishToCalls.filter((c) => c.channel === 'audience' || c.channel === 'singer')).toHaveLength(0);
    expect(hub.publishToCalls.some((c) => c.channel === 'stage')).toBe(true);
    expect(hub.publishToCalls.at(-1)?.state).toMatchObject({ view: 'control', counts: {}, state: { selected: FIRST, mode: 'paused' } });
  });

  it('take-selected publishes the selected position to every output channel', async () => {
    const { engine, hub } = await started();
    await engine.command(CONTROL_MEMBER, frame('pause'));
    await engine.command(CONTROL_MEMBER, frame('select', SECOND));
    hub.publishToCalls.length = 0;
    await engine.command(CONTROL_MEMBER, frame('take-selected'));
    expect(hub.publishToCalls.map((c) => c.channel).sort()).toEqual([...LIVE_CHANNELS].sort());
    expect(hub.publishToCalls.find((c) => c.channel === 'audience')?.state).toMatchObject({ frame: SECOND });
    expect(engine.state('run-1')).toMatchObject({ mode: 'live', public: SECOND });
  });

  it('persists an operator theme and publishes it to control alone', async () => {
    const { engine, themes, hub, runs, runEvents } = await started();
    expect(await engine.command(CONTROL_MEMBER, frame('theme', { surface: 'operator', themeId: 'stage-default' }))).toEqual({ outcome: 'applied' });
    expect(themes.changeTheme).toHaveBeenCalledWith(expect.objectContaining({ permissions: [PRESENTATION_CONTROL] }), {
      runId: 'run-1', surface: 'operator', theme: DEFAULT_THEMES.stage, pinnedRevisions: PINS,
    });
    expect(runs.advance).toHaveBeenCalledWith(expect.anything(), 'run-1', 7, expect.objectContaining({ themes: expect.objectContaining({ operator: 'stage-default' }) }), 9);
    expect(hub.changes).toMatchObject([{ type: LIVE_EVENT_TYPES.theme, stateRevision: 8 }]);
    expect(hub.publishToCalls.map((c) => c.channel)).toEqual([LIVE_CONTROL_CHANNEL]);
    expect(runEvents.record).not.toHaveBeenCalled();
  });

  it('sends a stage theme to stage and control only, and keeps it through the next slide', async () => {
    const { engine, hub } = await started();
    await engine.command(CONTROL_MEMBER, frame('theme', { surface: 'stage', themeId: 'audience-default' }));
    expect(hub.publishToCalls.map((c) => c.channel).sort()).toEqual(['live-control', 'stage']);
    expect(hub.publishToCalls.find((c) => c.channel === 'stage')?.state).toMatchObject({ themeId: 'audience-default' });
    hub.publishToCalls.length = 0;
    await engine.command(CONTROL_MEMBER, { ...frame('next'), clientStateRevision: 8 });
    expect(hub.publishToCalls.find((c) => c.channel === 'stage')?.state).toMatchObject({ themeId: 'audience-default' });
    expect(hub.publishToCalls.find((c) => c.channel === 'audience')?.state).toMatchObject({ themeId: 'audience-default' });
    expect(engine.state('run-1')?.themes.stage).toBe('audience-default');
  });

  it('answers a theme command stale when the run moved underneath it', async () => {
    const { engine, runs, hub } = await started();
    runs.advance.mockResolvedValueOnce('stale');
    expect(await engine.command(CONTROL_MEMBER, frame('theme', { surface: 'stage', themeId: 'stage-default' }))).toEqual({ outcome: 'stale' });
    expect(hub.publishChange).not.toHaveBeenCalled();
  });

  it('changes a theme over HTTP through the same path, and refuses a run it is not presenting', async () => {
    const { engine, runs, hub } = await started();
    const result = await engine.changeTheme(SESSION, 'run-1', 'singer', DEFAULT_THEMES.stage);
    expect(hub.changes).toMatchObject([{ type: LIVE_EVENT_TYPES.theme, stateRevision: 8 }]);
    expect(result.landed).toEqual({ sequence: 1, stateRevision: 9 });
    expect(hub.publishToCalls.map((c) => c.channel).sort()).toEqual(['live-control', 'singer']);
    await expect(engine.changeTheme(SESSION, 'run-9', 'singer', DEFAULT_THEMES.stage)).rejects.toMatchObject({ kind: 'state' });
    runs.advance.mockResolvedValueOnce('stale');
    await expect(engine.changeTheme(SESSION, 'run-1', 'singer', DEFAULT_THEMES.stage)).rejects.toMatchObject({ kind: 'conflict' });
    runs.advance.mockResolvedValueOnce(undefined);
    await expect(engine.changeTheme(SESSION, 'run-1', 'singer', DEFAULT_THEMES.stage)).rejects.toMatchObject({ kind: 'state' });
    runs.resume.mockResolvedValueOnce({ ...RECORD, phase: 'ended' });
    await expect(engine.changeTheme(SESSION, 'run-1', 'singer', DEFAULT_THEMES.stage)).rejects.toMatchObject({ kind: 'state' });
  });

  it('acks stale and publishes nothing on a lost CAS', async () => {
    const { engine, runs, hub } = await started();
    runs.advance.mockResolvedValue('stale');
    expect(await engine.command(CONTROL_MEMBER, frame('go-to', SECOND))).toEqual({ outcome: 'stale' });
    expect(hub.publishToCalls).toEqual([]);
    expect(engine.state('run-1')).toEqual(LIVE);
  });

  it('acks failed and publishes nothing when the run-event log write fails', async () => {
    const { engine, runs, runEvents, hub } = await started();
    runEvents.record.mockRejectedValue(new RunEventError('conflict', 'write failed'));
    expect(await engine.command(CONTROL_MEMBER, frame('go-to', SECOND))).toEqual({ outcome: 'failed' });
    expect(runs.advance).not.toHaveBeenCalled();
    expect(hub.publishToCalls).toHaveLength(0);
  });

  it('acks invalid for a command missing required args, before touching the run store', async () => {
    const { engine, runs, runEvents, deck } = await started();
    runs.resume.mockClear();
    deck.mockClear();
    expect(await engine.command(CONTROL_MEMBER, frame('go-to'))).toEqual({ outcome: 'invalid' });
    expect(runs.resume).not.toHaveBeenCalled();
    expect(runs.advance).not.toHaveBeenCalled();
    expect(runEvents.record).not.toHaveBeenCalled();
    expect(deck).not.toHaveBeenCalled();
  });

  it('records original pins and shown title before CAS and publication', async () => {
    const { engine, runs, runEvents, order, hub } = await started();
    await engine.command(CONTROL_MEMBER, frame('go-to', SECOND));
    expect(order).toEqual(['record', 'advance', 'publish']);
    expect(hub.publishChange).toHaveBeenCalledOnce();
    expect(hub.changes[0]?.stateRevision).toBe(8);
    expect(runEvents.record).toHaveBeenCalledWith({ ...SESSION, correlationId: 'live:account:operator:command-1' }, {
      runId: 'run-1', kind: LIVE_EVENT_TYPES.slide, pinnedRevisions: PINS, shown: { itemId: 'item-2', reference: 'Second song' },
    });
    expect(runs.advance).toHaveBeenCalledWith(expect.anything(), 'run-1', 7, expect.objectContaining({ public: SECOND }), 9);
    expect(hub.publishToCalls.find((c) => c.channel === 'singer')?.state).toMatchObject({ next: SECOND });
    expect(hub.publishToCalls.find((c) => c.channel === 'audience')?.state).not.toHaveProperty('selected');
  });

  // A real identity (a session actor) and a client's own frame id are both unbounded in practice; without
  // `correlationFor`'s guard, `live:${identity}:${frame.id}` overflows `context.ts`'s 64-character limit
  // and `requestContext` throws, crashing the whole process (every connected view, not just this command).
  it('bounds a long identity and frame id into a valid correlation id instead of throwing', async () => {
    const { engine, runEvents } = await started();
    const identity = 'account:'.padEnd(40, '0');
    const longMember: LiveMember = { channel: LIVE_CONTROL_CHANNEL, grant: grantFor(SESSION.permissions), identity };
    const longFrame = { ...frame('go-to', SECOND), id: 'x'.repeat(40) };
    await expect(engine.command(longMember, longFrame)).resolves.toEqual({ outcome: 'applied' });
    const usedContext = runEvents.record.mock.calls.at(-1)?.[0];
    expect(usedContext?.correlationId.length).toBeLessThanOrEqual(64);
    expect(usedContext?.correlationId).toMatch(/^live:[A-Za-z0-9:_-]{4,59}$/u);
  });

  it.each([
    ['go-to', null], ['select', { itemId: 'x', slideIndex: -1 }], ['select', { itemId: 'x', slideIndex: 0.5 }],
    ['go-to', { itemId: 3, slideIndex: 0 }], ['go-to', { itemId: 'x', slideIndex: '0' }],
    ['standby', {}], ['standby', { screenId: '' }], ['theme', {}],
    ['theme', { surface: 'unknown', themeId: 'stage-default' }], ['theme', { surface: 'stage', themeId: '' }],
    ['theme', { surface: 'stage', themeId: 'unknown' }], ['unrecognized', undefined],
  ])('acks invalid for %s with %j', async (type, args) => {
    const { engine, runs, runEvents, themes } = await started();
    expect(await engine.command(CONTROL_MEMBER, frame(type, args))).toEqual({ outcome: 'invalid' });
    expect(runs.advance).not.toHaveBeenCalled();
    expect(runEvents.record).not.toHaveBeenCalled();
    expect(themes.changeTheme).not.toHaveBeenCalled();
  });

  it.each(['stage', 'singer', 'audience'] as const)('refuses %s members before reading anything', async (channel) => {
    const { engine, runs } = setup();
    expect(await engine.command({ channel, grant: grantFor([]) }, frame('go-to'))).toEqual({ outcome: 'unauthorized' });
    expect(runs.resume).not.toHaveBeenCalled();
  });

  it('acks failed with no active run without touching stores', async () => {
    const { engine, runs } = setup();
    expect(await engine.command(CONTROL_MEMBER, frame('pause'))).toEqual({ outcome: 'failed' });
    expect(runs.resume).not.toHaveBeenCalled();
  });

  it('acks failed when the current run disappears', async () => {
    const { engine, runs } = await started();
    runs.resume.mockResolvedValue(undefined);
    expect(await engine.command(CONTROL_MEMBER, frame('pause'))).toEqual({ outcome: 'failed' });
    expect(runs.advance).not.toHaveBeenCalled();
  });

  it('acks failed when the run disappears during CAS', async () => {
    const { engine, runs, hub } = await started();
    runs.advance.mockResolvedValue(undefined);
    expect(await engine.command(CONTROL_MEMBER, frame('pause'))).toEqual({ outcome: 'failed' });
    expect(hub.publishToCalls).toEqual([]);
  });

  it.each([
    ['resume', (built: ReturnType<typeof setup>) => built.runs.resume.mockRejectedValue(new Error('mongo down'))],
    ['deck', (built: ReturnType<typeof setup>) => built.deck.mockRejectedValue(new Error('no slide group revision 3'))],
    ['advance', (built: ReturnType<typeof setup>) => built.runs.advance.mockRejectedValue(new Error('write concern failed'))],
  ] as const)('acks failed rather than throwing when %s throws', async (_step, fail) => {
    const built = await started();
    fail(built);
    await expect(built.engine.command(CONTROL_MEMBER, frame('go-to', SECOND))).resolves.toEqual({ outcome: 'failed' });
    expect(built.hub.publishToCalls).toEqual([]);
  });

  it('uses freshly read state for navigation and CAS', async () => {
    const { engine, runs } = await started();
    runs.resume.mockResolvedValue({ ...RECORD, stateRevision: 12, live: { ...LIVE, public: SECOND, selected: SECOND } });
    await engine.command(CONTROL_MEMBER, frame('previous'));
    expect(runs.advance).toHaveBeenCalledWith(expect.anything(), 'run-1', 12, expect.objectContaining({ selected: { ...FIRST, slideIndex: 1 } }), 9);
  });

  it('refuses navigation from a position not found in the deck', async () => {
    const { engine, runs, runEvents } = await started();
    runs.resume.mockResolvedValue({ ...RECORD, live: { ...LIVE, selected: { itemId: 'absent', slideIndex: 0 } } });
    expect(await engine.command(CONTROL_MEMBER, frame('next'))).toEqual({ outcome: 'invalid' });
    expect(runEvents.record).not.toHaveBeenCalled();
  });

  it('keeps standby public during private selection and reveals it on resume', async () => {
    const { engine, hub } = await started();
    await engine.command(CONTROL_MEMBER, frame('standby', { screenId: 'welcome' }));
    expect(engine.state('run-1')?.public).toEqual({ standby: 'welcome' });
    hub.publishToCalls.length = 0;
    await engine.command(CONTROL_MEMBER, frame('select', SECOND));
    expect(engine.state('run-1')?.public).toEqual({ standby: 'welcome' });
    expect(hub.publishToCalls.map((c) => c.channel)).toEqual(['stage', LIVE_CONTROL_CHANNEL]);
    await engine.command(CONTROL_MEMBER, frame('resume-live'));
    expect(engine.state('run-1')).toMatchObject({ mode: 'live', public: SECOND });
  });

  it('return-to-live discards private selection without moving public', async () => {
    const { engine } = await started();
    await engine.command(CONTROL_MEMBER, frame('pause'));
    await engine.command(CONTROL_MEMBER, frame('select', SECOND));
    await engine.command(CONTROL_MEMBER, frame('return-to-live'));
    expect(engine.state('run-1')).toMatchObject({ mode: 'live', public: FIRST, selected: FIRST });
  });

  it.each(['permission', 'schema', 'conflict', 'corrupt'] as const)('maps theme %s refusal to an ack', async (kind) => {
    const { engine, themes, hub } = await started();
    themes.changeTheme.mockRejectedValue(new RunEventError(kind, 'refused'));
    expect(await engine.command(CONTROL_MEMBER, frame('theme', { surface: 'stage', themeId: 'stage-default' })))
      .toEqual({ outcome: kind === 'permission' || kind === 'schema' ? 'invalid' : 'failed' });
    expect(hub.publishToCalls).toEqual([]);
  });
});

describe('run-engine lifecycle', () => {
  it('starts with cached state, broadcasts and warms the deck', async () => {
    const { engine, hub, deck, runs } = setup();
    expect(engine.state('missing')).toBeUndefined();
    expect(await engine.start(SESSION, { serviceId: 'service-1', mode: 'live' })).toEqual(RECORD);
    expect(engine.state('run-1')).toEqual(LIVE);
    expect(runs.start).toHaveBeenCalledWith(SESSION, { serviceId: 'service-1', mode: 'live' }, 8);
    expect(hub.changes).toMatchObject([{ type: 'run-state-changed', everyone: true, stateRevision: RECORD.stateRevision }]);
    expect(Object.keys(hub.changes[0]?.states ?? {}).sort()).toEqual([...LIVE_CHANNELS].sort());
    expect(deck).toHaveBeenCalledWith(expect.objectContaining({ actor: SESSION.actor, correlationId: SESSION.correlationId }), RECORD);
  });

  it('propagates start and deck failures', async () => {
    const { engine, runs, deck } = setup();
    runs.start.mockRejectedValueOnce(new RunError('state', 'not ready'));
    await expect(engine.start(SESSION, { serviceId: 'service-1', mode: 'live' })).rejects.toMatchObject({ kind: 'state' });
    deck.mockRejectedValue(new Error('missing deck'));
    await expect(engine.start(SESSION, { serviceId: 'service-1', mode: 'live' })).rejects.toThrow('missing deck');
  });

  it('ends an existing run and keeps it queryable', async () => {
    const { engine, hub, runs } = await started();
    expect(await engine.end(SESSION, 'run-1')).toMatchObject({ phase: 'ended' });
    expect(engine.state('run-1')).toEqual(LIVE);
    expect(runs.end).toHaveBeenCalledWith(SESSION, 'run-1', 9);
    expect(hub.changes).toEqual([{ type: 'run-state-changed', states: {}, everyone: true, stateRevision: RECORD.stateRevision }]);
    runs.end.mockResolvedValue(undefined);
    expect(await engine.end(SESSION, 'missing')).toBeUndefined();
    expect(hub.publishChange).toHaveBeenCalledOnce();
  });
});

describe('run-engine restore', () => {
  it('seeds the hub from the highest revision of any run and each view from the latest active run', async () => {
    const { engine, runs, hub, runEvents } = setup();
    const latest = { ...RECORD, runId: 'run-2', stateRevision: 22, live: { ...LIVE, runId: 'run-2', selected: SECOND } };
    const ended = { ...RECORD, runId: 'run-0', phase: 'ended' as const, stateRevision: 30 };
    runs.list.mockResolvedValue([latest, ended, { ...RECORD, runId: 'run-3', stateRevision: 25 }]);
    await engine.restore();
    expect(engine.state('run-2')).toEqual(latest.live);
    expect(engine.state('run-3')).toBeDefined();
    expect(engine.state('run-0')).toBeUndefined();
    expect(hub.seedStateRevision).toHaveBeenCalledWith(30);
    const [seeded] = hub.seedStates.mock.calls[0] ?? [];
    expect(Object.keys(seeded ?? {}).sort()).toEqual([...LIVE_CHANNELS].sort());
    expect(seeded?.['live-control']).toMatchObject({ view: 'control', state: { runId: 'run-2', selected: SECOND } });
    expect(seeded?.singer).toMatchObject({ view: 'singer', frame: FIRST, next: { itemId: 'item-1', slideIndex: 1 } });
    expect(runEvents.log).not.toHaveBeenCalled();
    expect(hub.publishChange).not.toHaveBeenCalled();
    expect(runs.list).toHaveBeenCalledWith(expect.objectContaining({ actor: 'system', permissions: expect.arrayContaining(['presentationRuns.read']) }));
    await engine.command(CONTROL_MEMBER, frame('pause'));
    expect(runs.resume).toHaveBeenCalledWith(expect.anything(), 'run-2');
  });

  it('still seeds position, mode and theme when the deck cannot be derived on restore', async () => {
    const { engine, hub, deck } = setup();
    deck.mockRejectedValue(new Error('missing pin'));
    await engine.restore();
    const [seeded] = hub.seedStates.mock.calls[0] ?? [];
    expect(seeded?.singer).toMatchObject({ frame: FIRST });
    expect(seeded?.singer).not.toHaveProperty('next');
  });

  it('seeds only the revision when every run has ended', async () => {
    const { engine, runs, hub } = setup();
    runs.list.mockResolvedValue([{ ...RECORD, phase: 'ended' }]);
    await engine.restore();
    expect(hub.seedStateRevision).toHaveBeenCalledWith(7);
    expect(hub.seedStates).not.toHaveBeenCalled();
    expect(await engine.command(CONTROL_MEMBER, frame('pause'))).toEqual({ outcome: 'failed' });
  });

  it('leaves an empty deployment without a current run or a revision bump', async () => {
    const { engine, runs, hub } = setup();
    runs.list.mockResolvedValue([]);
    await engine.restore();
    expect(hub.seedStateRevision).not.toHaveBeenCalled();
    expect(await engine.command(CONTROL_MEMBER, frame('pause'))).toEqual({ outcome: 'failed' });
  });
});
