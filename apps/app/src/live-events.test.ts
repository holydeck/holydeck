import { OUTPUT_CHANNELS } from '@holydeck/contracts/live';
import { describe, expect, it } from 'vitest';

import {
  LIVE_EVENT_TYPES,
  publishRunStateChanged,
  publishSlideChanged,
  publishStandbyChanged,
  publishThemeChanged,
} from './live-events.js';
import { grantFor, liveHub } from './live-protocol.js';

import type { LiveHub, LiveTransport } from './live-protocol.js';
import type { OutputChannel } from '@holydeck/contracts/live';

const AT = '2026-09-19T10:00:00.000Z';

type Frame = Record<string, unknown>;

/** A joined output surface, kept only for the frames it was actually written — nothing it had to ask for. */
const watching = (hub: LiveHub, channel: OutputChannel): { frames(): readonly Frame[] } => {
  const written: string[] = [];
  const transport: LiveTransport = {
    send: (text) => written.push(text),
    close: () => {},
    buffered: () => 0,
  };
  hub.join(transport, channel, grantFor([]));
  return { frames: (): readonly Frame[] => written.map((text) => JSON.parse(text) as Frame) };
};

const hubAt = (): LiveHub => liveHub({ clock: () => AT });

describe('the four change classes LIVE-04 names', () => {
  it('are the stable, lower-case-hyphenated wire names LIVE-12’s run log will group by', () => {
    expect(LIVE_EVENT_TYPES).toEqual({
      slide: 'current-slide-changed',
      standby: 'standby-changed',
      theme: 'theme-changed',
      runState: 'run-state-changed',
    });
  });

  it('each land the hub one step further, the same shape a command lands at', () => {
    const hub = hubAt();
    expect(publishSlideChanged(hub)).toEqual({ stateRevision: 1, sequence: 1 });
    expect(publishStandbyChanged(hub)).toEqual({ stateRevision: 2, sequence: 2 });
    expect(publishThemeChanged(hub)).toEqual({ stateRevision: 3, sequence: 3 });
    expect(publishRunStateChanged(hub)).toEqual({ stateRevision: 4, sequence: 4 });
  });

  it('reach every authorized view as one pushed event apiece, in the order they were called, nothing polled', () => {
    const hub = hubAt();
    const surfaces = OUTPUT_CHANNELS.map((channel) => watching(hub, channel));

    publishSlideChanged(hub);
    publishStandbyChanged(hub);
    publishThemeChanged(hub);
    publishRunStateChanged(hub);

    for (const surface of surfaces) {
      // One write per change and no more: a view that never asked again was never sent again either.
      const events = surface.frames().filter((frame) => frame['kind'] === 'event');
      expect(events).toHaveLength(4);
      expect(events.map((frame) => frame['type'])).toEqual([
        'current-slide-changed',
        'standby-changed',
        'theme-changed',
        'run-state-changed',
      ]);
      expect(events.map((frame) => frame['sequence'])).toEqual([1, 2, 3, 4]);
    }
  });
});
