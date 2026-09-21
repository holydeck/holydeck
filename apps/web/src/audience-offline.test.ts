import { describe, expect, it, vi } from 'vitest';

import { LOCALES } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

import { LIVE_SESSION_STATES } from '@holydeck/contracts/live';

import {
  createAudienceOfflineController,
  nextAudienceOfflinePosition,
  presentAudienceOfflineState,
  previousAudienceOfflinePosition,
  type AudienceOfflineLiveClient,
  type AudienceOfflineState,
} from './audience-offline.js';

import type { LiveSessionState } from '@holydeck/contracts/live';
import type { LiveStatus } from './live-client.js';
import type { RehearsalBlocker, RehearsalReport } from './preparation-rehearsal.js';

const rehearsedReport = (rehearsedSlideIds: readonly string[]): RehearsalReport => ({
  kind: 'rehearsed',
  documents: [],
  rehearsedSlideIds,
  blockers: [],
});

const blockedReport = (blockers: readonly RehearsalBlocker[]): RehearsalReport => ({
  kind: 'blocked',
  documents: [],
  rehearsedSlideIds: [],
  blockers,
});

/** A live context double that also carries the mutating methods a real `LiveClient` has, spied so a
 *  test can prove they are never reached — `AudienceOfflineLiveClient` never names them, but this proves
 *  it at runtime too, not only at the type checker. */
function fakeLiveClient(initialState: LiveSessionState): {
  live: AudienceOfflineLiveClient;
  emit: (state: LiveSessionState) => void;
  command: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  let status: LiveStatus = { state: initialState, stateRevision: 1, sequence: 1 };
  const listeners = new Set<(status: LiveStatus) => void>();
  const command = vi.fn();
  const connect = vi.fn();
  const close = vi.fn();

  const live: AudienceOfflineLiveClient = {
    get status() {
      return status;
    },
    onStatus(listener: (status: LiveStatus) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    live,
    emit(state: LiveSessionState): void {
      status = { state, stateRevision: 1, sequence: 1 };
      for (const listener of listeners) listener(status);
    },
    command,
    connect,
    close,
  };
}

const statusOf = (): { textContent: string | null } => ({ textContent: null });

describe('nextAudienceOfflinePosition', () => {
  it('moves forward while another slide remains', () => {
    expect(nextAudienceOfflinePosition(3, 0)).toBe(1);
    expect(nextAudienceOfflinePosition(3, 1)).toBe(2);
  });

  it('does not wrap around at the last slide', () => {
    expect(nextAudienceOfflinePosition(3, 2)).toBeUndefined();
    expect(nextAudienceOfflinePosition(1, 0)).toBeUndefined();
  });
});

describe('previousAudienceOfflinePosition', () => {
  it('moves back while an earlier slide remains', () => {
    expect(previousAudienceOfflinePosition(2)).toBe(1);
    expect(previousAudienceOfflinePosition(1)).toBe(0);
  });

  it('does not wrap around at the first slide', () => {
    expect(previousAudienceOfflinePosition(0)).toBeUndefined();
  });
});

describe('createAudienceOfflineController', () => {
  it('reads live, claiming nothing else, while the live status is synchronised', () => {
    const { live } = fakeLiveClient('synchronised');
    const controller = createAudienceOfflineController(live, rehearsedReport(['s1', 's2']), vi.fn());
    expect(controller.state).toStrictEqual({ kind: 'live' });
  });

  it.each(LIVE_SESSION_STATES.filter((state) => state !== 'synchronised'))(
    'reads offline for live status %s, never claiming remote authority',
    (state) => {
      const { live } = fakeLiveClient(state);
      const controller = createAudienceOfflineController(live, rehearsedReport(['s1']), vi.fn());
      expect(controller.state.kind).not.toBe('live');
    },
  );

  it('continues read-only navigation from the verified snapshot while offline', () => {
    const { live } = fakeLiveClient('closed');
    const onChange = vi.fn();
    const controller = createAudienceOfflineController(live, rehearsedReport(['s1', 's2', 's3']), onChange);

    expect(controller.state).toStrictEqual({
      kind: 'offline',
      position: 0,
      slideId: 's1',
      totalSlides: 3,
      canGoNext: true,
      canGoPrevious: false,
    });

    controller.next();
    expect(controller.state).toStrictEqual({
      kind: 'offline',
      position: 1,
      slideId: 's2',
      totalSlides: 3,
      canGoNext: true,
      canGoPrevious: true,
    });
    expect(onChange).toHaveBeenLastCalledWith(controller.state);

    controller.next();
    expect(controller.state).toMatchObject({ position: 2, slideId: 's3', canGoNext: false, canGoPrevious: true });

    controller.previous();
    controller.previous();
    expect(controller.state).toMatchObject({ position: 0, slideId: 's1', canGoNext: true, canGoPrevious: false });
  });

  it('does not wrap around at either end of the offline slide order', () => {
    const { live } = fakeLiveClient('closed');
    const onChange = vi.fn();
    const controller = createAudienceOfflineController(live, rehearsedReport(['only']), onChange);

    controller.previous();
    expect(controller.state).toMatchObject({ position: 0 });
    expect(onChange).not.toHaveBeenCalled();

    controller.next();
    expect(controller.state).toMatchObject({ position: 0 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is unavailable offline when the rehearsal report is blocked', () => {
    const blockers: RehearsalBlocker[] = [{ code: 'snapshot.noDocuments' }];
    const { live } = fakeLiveClient('degraded');
    const controller = createAudienceOfflineController(live, blockedReport(blockers), vi.fn());
    expect(controller.state).toStrictEqual({ kind: 'unavailable', blockers });
  });

  it('is unavailable offline when the rehearsal report has no slides to show', () => {
    const { live } = fakeLiveClient('resuming');
    const controller = createAudienceOfflineController(live, rehearsedReport([]), vi.fn());
    expect(controller.state).toStrictEqual({ kind: 'unavailable', blockers: [] });
  });

  it('exposes no mutation path: no member but state, next, previous and dispose', () => {
    const { live } = fakeLiveClient('closed');
    const controller = createAudienceOfflineController(live, rehearsedReport(['s1']), vi.fn());
    expect(Object.keys(controller).sort()).toStrictEqual(['dispose', 'next', 'previous', 'state']);
    expect('command' in controller).toBe(false);
    expect('connect' in controller).toBe(false);
  });

  it('never reaches the live client mutating methods across a full run', () => {
    const { live, emit, command, connect, close } = fakeLiveClient('synchronised');
    const onChange = vi.fn();
    const controller = createAudienceOfflineController(live, rehearsedReport(['s1', 's2']), onChange);

    controller.next();
    controller.previous();
    emit('closed');
    controller.next();
    controller.previous();
    controller.dispose();

    expect(command).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('makes next and previous no-ops while live, asserting the mutation path unavailable', () => {
    const { live } = fakeLiveClient('synchronised');
    const onChange = vi.fn();
    const controller = createAudienceOfflineController(live, rehearsedReport(['s1', 's2']), onChange);

    controller.next();
    controller.previous();

    expect(controller.state).toStrictEqual({ kind: 'live' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('makes next and previous no-ops while unavailable', () => {
    const { live } = fakeLiveClient('closed');
    const onChange = vi.fn();
    const controller = createAudienceOfflineController(live, rehearsedReport([]), onChange);

    controller.next();
    controller.previous();

    expect(controller.state).toStrictEqual({ kind: 'unavailable', blockers: [] });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a network loss during a live run as a failure injection, without wraparound state loss', () => {
    const { live, emit } = fakeLiveClient('synchronised');
    const onChange = vi.fn();
    const controller = createAudienceOfflineController(live, rehearsedReport(['s1', 's2']), onChange);

    expect(controller.state).toStrictEqual({ kind: 'live' });

    emit('closed');

    expect(controller.state).toStrictEqual({
      kind: 'offline',
      position: 0,
      slideId: 's1',
      totalSlides: 2,
      canGoNext: true,
      canGoPrevious: false,
    });
    expect(onChange).toHaveBeenCalledWith(controller.state);

    const before = controller.state;
    controller.next();
    expect(controller.state).not.toStrictEqual(before);
  });

  it('recovers the live reading once the connection resynchronises', () => {
    const { live, emit } = fakeLiveClient('closed');
    const onChange = vi.fn();
    const controller = createAudienceOfflineController(live, rehearsedReport(['s1']), onChange);

    emit('synchronised');

    expect(controller.state).toStrictEqual({ kind: 'live' });
    expect(onChange).toHaveBeenCalledWith({ kind: 'live' });
  });

  it('stops watching the live status once disposed', () => {
    const { live, emit } = fakeLiveClient('synchronised');
    const onChange = vi.fn();
    const controller = createAudienceOfflineController(live, rehearsedReport(['s1']), onChange);

    controller.dispose();
    emit('closed');

    expect(controller.state).toStrictEqual({ kind: 'live' });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('presentAudienceOfflineState', () => {
  const cases: ReadonlyArray<[string, AudienceOfflineState, string]> = [
    ['live', { kind: 'live' }, 'audienceOffline.live'],
    [
      'offline',
      { kind: 'offline', position: 0, slideId: 's1', totalSlides: 1, canGoNext: false, canGoPrevious: false },
      'audienceOffline.offline',
    ],
    ['unavailable', { kind: 'unavailable', blockers: [] }, 'audienceOffline.unavailable'],
  ];

  it.each(cases)('presents the %s state in every shipped locale', (_label, state, key) => {
    for (const locale of LOCALES) {
      const status = statusOf();
      presentAudienceOfflineState(status, state, locale);
      expect(status.textContent).toBe(translate(locale, key as never));
    }
  });

  it('never presents the offline state as though it were live', () => {
    const status = statusOf();
    presentAudienceOfflineState(
      status,
      { kind: 'offline', position: 0, slideId: 's1', totalSlides: 1, canGoNext: false, canGoPrevious: false },
      'en',
    );
    expect(status.textContent).not.toBe(translate('en', 'audienceOffline.live'));
    expect(status.textContent).toBe(translate('en', 'audienceOffline.offline'));
  });
});
