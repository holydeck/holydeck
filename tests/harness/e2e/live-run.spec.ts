// The live run engine's own journey (RUN-01/05/08/09; LIVE-01/04/05/08/09/12/13/14; BIBL-04's server
// half), proved over the real wire rather than through any one module's unit tests: prepare a Service,
// start a live run, command it from live-control, and confirm the resulting event reaches every output
// channel carrying only the projection the wire is meant to enforce (Design §2) — nothing a stage or
// audience surface may not see. No `page`, no browser: spec 05's own scope stops at the API a UI (spec
// 07) is later built onto, the same boundary `control.spec.ts`'s first test already draws for the order
// route. Runs on every project the way that test does; a fresh Service per run means the three repeats
// never collide over `runs.ts`'s per-service "already active" guard. The command's idempotency key must
// be just as fresh: `landedKey` (live-protocol.ts) scopes it by `identity` alone, not by run or channel,
// and every project signs in as the same control actor, so a literal key landed by the desktop project
// would read back as `duplicate` for tablet and phone.

import { randomUUID } from 'node:crypto';

import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CHANNEL_QUERY, CLIENT_VERSION_QUERY, LIVE_CONTROL_CHANNEL, LIVE_PATH } from '@holydeck/contracts/live';
import { CSRF_HEADER, TICKET_QUERY } from '@holydeck/contracts/sessions';
import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';

import { signInWithControlTo } from '../src/identity.js';

import type { AckFrame, EventFrame, LiveChannel, LiveFrame, SnapshotFrame } from '@holydeck/contracts/live';
import type { SignedIn } from '../src/identity.js';

// None of these three have a contracts-package counterpart the way `LIVE_PATH`/`ORDER_PATH` do — they
// are `run-routes.ts`/`service-routes.ts`/`preparation-routes.ts`'s own local constants, not exported
// across the package boundary — so they are named here the same literal way `control.spec.ts` already
// names a page route it has no export for either.
const SERVICE_PATH = '/api/v1/services';
const preparePath = (serviceId: string): string => `/api/v1/services/${serviceId}/prepare`;
const RUN_PATH = '/api/v1/runs';

const jsonHeaders = (base: string, session: SignedIn): Record<string, string> => ({
  'content-type': 'application/json',
  origin: base,
  cookie: session.cookie,
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  [CSRF_HEADER]: session.csrf,
});

interface OpenSocket {
  readonly frames: readonly LiveFrame[];
  send(frame: unknown): void;
  waitFor(predicate: (frame: LiveFrame) => boolean, timeoutMs?: number): Promise<LiveFrame>;
  close(): void;
}

/**
 * Opens one authenticated live session the way a real client does — a session's `Cookie`, a matching
 * `Origin`, and a ticket spent once (`proveHandshake`, apps/app/src/live.ts) — which is why this uses
 * the `ws` package rather than the platform `WebSocket`: the latter cannot set request headers at all
 * (WHATWG spec), and a handshake here has no other way to carry the session that opens it.
 */
async function openLiveSocket(base: string, session: SignedIn, channel: LiveChannel): Promise<OpenSocket> {
  const ticket = await session.ticket();
  const url = new URL(`${base}${LIVE_PATH}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set(CHANNEL_QUERY, channel);
  url.searchParams.set(CLIENT_VERSION_QUERY, String(CLIENT_WINDOW.current));
  url.searchParams.set(TICKET_QUERY, ticket);

  const socket = new WebSocket(url, { headers: { cookie: session.cookie, origin: base } });
  const frames: LiveFrame[] = [];
  socket.on('message', (data: Buffer) => frames.push(JSON.parse(String(data)) as LiveFrame));

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  return {
    frames,
    send: (frame: unknown): void => socket.send(JSON.stringify(frame)),
    waitFor: async (predicate, timeoutMs = 10_000): Promise<LiveFrame> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find(predicate);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for a ${channel} frame`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    close: (): void => socket.close(),
  };
}

test.describe('the live run API journey', () => {
  test('starts a run, commands it from live-control, and fans the change out under the wire\'s own privacy projection', async ({
    baseURL,
  }) => {
    const base = baseURL!;
    const session = await signInWithControlTo(base);

    // A Service with just enough shown content to leave `readiness()`'s `NOTHING_TO_SHOW` blocker
    // behind, without depending on the library/slide-group content stores this milestone has no HTTP
    // route to seed: `run-deck.ts` derives the run's navigable deck from a prepared snapshot's
    // `generatedSlides` alone, which a `custom-slide` item never populates, so the deck stays empty and
    // the journey commands by explicit position (`go-to`) rather than by stepping through it.
    const created = await fetch(`${base}${SERVICE_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(base, session),
      body: JSON.stringify({
        title: 'Live run journey',
        date: '2026-09-23',
        site: 'Main Hall',
        sections: [
          {
            id: 'section-1',
            name: 'Welcome',
            items: [{ id: 'item-1', kind: 'custom-slide', title: 'Welcome', enabled: true }],
          },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const service = (await created.json()) as { data: { stamp: { id: string } } };
    const serviceId = service.data.stamp.id;

    // Placeholder pins: `prepare()` stores each as an opaque string and never resolves it against a real
    // content store, so any non-empty value is as valid here as a real one — only `slideLayout` (a
    // required field) and `aspectRatio` (`aspectRatioOf`) are pattern-checked.
    const prepared = await fetch(`${base}${preparePath(serviceId)}`, {
      method: 'POST',
      headers: jsonHeaders(base, session),
      body: JSON.stringify({
        slideLayout: { id: 'layout-1', revision: 1 },
        serviceTemplate: 'template-1@1',
        settings: 'settings@1',
        media: 'media@1',
        corpus: 'corpus@1',
        aspectRatio: '16:9',
      }),
    });
    expect(prepared.status).toBe(200);

    const started = await fetch(`${base}${RUN_PATH}`, {
      method: 'POST',
      headers: jsonHeaders(base, session),
      body: JSON.stringify({ serviceId, mode: 'live' }),
    });
    expect(started.status).toBe(201);

    const control = await openLiveSocket(base, session, LIVE_CONTROL_CHANNEL);
    const audience = await openLiveSocket(base, session, 'audience');
    const stage = await openLiveSocket(base, session, 'stage');
    try {
      // The snapshot every join carries no state of its own (`snapshotAt`, live-protocol.ts) — only the
      // revision a command is issued against.
      const snapshot = (await control.waitFor((frame) => frame.kind === 'snapshot')) as SnapshotFrame;

      const commandId = randomUUID();
      control.send({
        kind: 'command',
        channel: LIVE_CONTROL_CHANNEL,
        id: commandId,
        idempotencyKey: commandId,
        type: 'go-to',
        clientStateRevision: snapshot.stateRevision,
        args: { itemId: 'item-1', slideIndex: 0 },
      });

      const ack = (await control.waitFor(
        (frame) => frame.kind === 'ack' && frame.id === commandId,
      )) as AckFrame;
      expect(ack.outcome).toBe('applied');

      const audienceEvent = (await audience.waitFor((frame) => frame.kind === 'event')) as EventFrame;
      const audienceState = audienceEvent.state as Record<string, unknown>;
      expect(audienceState['frame']).toEqual({ itemId: 'item-1', slideIndex: 0 });
      // The privacy projection itself (`projectFor`, live-state.ts): the audience view carries only its
      // own five fields, never `selected`, `mode`, `next`, or the raw `state` a control view alone gets —
      // proved on the wire, not just in the pure reducer's own unit test.
      expect(Object.keys(audienceState).sort()).toEqual(
        ['additionsRevision', 'frame', 'runId', 'snapshotId', 'themeId', 'view'].sort(),
      );

      const stageEvent = (await stage.waitFor((frame) => frame.kind === 'event')) as EventFrame;
      const stageState = stageEvent.state as Record<string, unknown>;
      expect(stageState['frame']).toEqual({ itemId: 'item-1', slideIndex: 0 });
      expect(stageState['mode']).toBe('live');
    } finally {
      control.close();
      audience.close();
      stage.close();
    }
  });
});
