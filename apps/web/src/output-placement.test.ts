import { CSRF_HEADER } from '@holydeck/contracts/sessions';
import { OUTPUT_CAPABILITY_PATH, capabilityPath } from '@holydeck/contracts/live';
import { initialLiveModeState, publicFrameOf, select, takeSelectedLive } from '@holydeck/contracts/live-mode';
import { describe, expect, it, vi } from 'vitest';

import { createLiveClient } from './live-client.js';
import { getDeviceId, loadArrangement } from './output-arrangements.js';
import { createOutputPlacement, namedScreens, presentPlacement } from './output-placement.js';

import type { RequestInitLike } from './api.js';
import type { LiveClient, LiveCredentials, SocketEventLike, WebSocketLike } from './live-client.js';
import type { StorageLike } from './output-arrangements.js';
import type { DetectedScreen, ScreenDetection, SurfaceLaunchControls, WindowOpenerLike } from './output-launch.js';
import type { OutputPlacement, SurfacePlacement } from './output-placement.js';
import type { LiveModeState } from '@holydeck/contracts/live-mode';
import type { OutputChannel } from '@holydeck/contracts/live';

const AT = '2026-09-20T09:00:00.000Z';
const EXPIRES = '2026-09-20T12:00:00.000Z';
const ORIGIN = 'https://deployment.invalid';
const SERVICE = 'service-7';

const MAIN: DetectedScreen = { left: 0, top: 0, width: 1440, height: 900, isPrimary: true };
const HALL: DetectedScreen = { left: 1440, top: 0, width: 1920, height: 1080, isPrimary: false };
const FOLDBACK: DetectedScreen = { left: -1280, top: 0, width: 1280, height: 720, isPrimary: false };

const DETECTED: ScreenDetection = { kind: 'detected', screens: [MAIN, HALL, FOLDBACK] };
const ABSENT: ScreenDetection = { kind: 'unavailable', reason: 'api-absent' };
const REFUSED: ScreenDetection = { kind: 'unavailable', reason: 'permission-denied' };

const featuresOf = (screen: DetectedScreen): string =>
  `left=${screen.left},top=${screen.top},width=${screen.width},height=${screen.height}`;

// ---------------------------------------------------------------------------------------------------
// The window this client opens surfaces in, and the application it asks for their capabilities
// ---------------------------------------------------------------------------------------------------

interface Opened {
  readonly url: string;
  readonly target: string;
  readonly features: string | undefined;
}

const opener = (blocked: readonly OutputChannel[] = []): { window: WindowOpenerLike; opened: Opened[] } => {
  const opened: Opened[] = [];
  return {
    opened,
    window: {
      open(url: string, target: string, features?: string): object | null {
        opened.push({ url, target, features });
        return blocked.some((view) => target.endsWith(view)) ? null : {};
      },
    },
  };
};

interface Sent {
  readonly url: string;
  readonly method: string | undefined;
  readonly body: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;
}

interface Application {
  readonly fetching: (url: string, init: RequestInitLike) => Promise<{ status: number; json(): Promise<unknown> }>;
  readonly sent: Sent[];
  issues(): readonly Sent[];
  revocations(): readonly string[];
}

/**
 * `capability-routes.ts` as this client sees it: one path issues an output capability for exactly the
 * view it was asked for, one path gives an issued one up again, and a session without Control
 * presentation is refused before either happens. `answering` lets a test bend the answer itself, which
 * is the only way to prove this module checks what came back rather than trusting it.
 */
const application = (
  options: {
    readonly refuse?: boolean;
    /** Refuse once this many capabilities have been issued — a refusal part-way through one action. */
    readonly refuseAfter?: number;
    readonly answering?: (view: OutputChannel, ordinal: number) => unknown;
  } = {},
): Application => {
  const sent: Sent[] = [];
  let ordinal = 0;
  return {
    sent,
    issues: () => sent.filter((call) => call.url === OUTPUT_CAPABILITY_PATH),
    revocations: () => sent.filter((call) => call.method === 'DELETE').map((call) => call.url),
    fetching: async (url, init) => {
      sent.push({
        url,
        method: init.method,
        body: init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>),
        headers: init.headers,
      });
      if (url !== OUTPUT_CAPABILITY_PATH) {
        return { status: 200, json: async () => ({ data: { revoked: true }, meta: { requestId: 'req-r' } }) };
      }
      if (options.refuse === true || (options.refuseAfter !== undefined && ordinal >= options.refuseAfter)) {
        return {
          status: 403,
          json: async () => ({
            error: { code: 'request.forbidden', message: 'Control presentation is required.', requestId: 'req-f' },
          }),
        };
      }
      ordinal += 1;
      const view = (init.body === undefined ? '' : (JSON.parse(init.body) as { view: OutputChannel }).view) as OutputChannel;
      const data =
        options.answering === undefined
          ? {
              token: `token-${view}-${ordinal}`,
              capabilityId: `cap-${ordinal}`,
              kind: 'output',
              service: SERVICE,
              view,
              expiresAt: EXPIRES,
            }
          : options.answering(view, ordinal);
      return { status: 201, json: async () => ({ data, meta: { requestId: `req-${ordinal}` } }) };
    },
  };
};

const storage = (): StorageLike => {
  const held = new Map<string, string>();
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, value);
    },
  };
};

const placementOn = (
  window: WindowOpenerLike,
  app: Application,
  overrides: Partial<Parameters<typeof createOutputPlacement>[0]> = {},
): OutputPlacement =>
  createOutputPlacement({
    window,
    fetching: app.fetching,
    service: SERVICE,
    csrf: 'csrf-1',
    expiresAt: () => EXPIRES,
    urlFor: (view, token) => `${ORIGIN}/output/${view}?capability=${token}`,
    ...overrides,
  });

const forView = (placements: readonly SurfacePlacement[], view: OutputChannel): SurfacePlacement => {
  const found = placements.find((placement) => placement.view === view);
  if (found === undefined) throw new Error(`nothing was reported for ${view}`);
  return found;
};

// ---------------------------------------------------------------------------------------------------
// Assigning a surface to a screen
// ---------------------------------------------------------------------------------------------------

describe('assigning an output surface to a detected screen', () => {
  it('opens each surface on the screen it was assigned, not the one the browser offered', async () => {
    const { window, opened } = opener();
    const app = application();
    const placement = placementOn(window, app);

    const audience = await placement.place('audience', HALL, DETECTED);
    const stage = await placement.place('stage', FOLDBACK, DETECTED);
    const singer = await placement.place('singer', MAIN, DETECTED);

    expect([audience.applied, stage.applied, singer.applied]).toEqual([true, true, true]);
    expect(opened.map((entry) => [entry.target, entry.features])).toEqual([
      ['holydeck-output-audience', featuresOf(HALL)],
      ['holydeck-output-stage', featuresOf(FOLDBACK)],
      ['holydeck-output-singer', featuresOf(MAIN)],
    ]);
    expect(placement.assignments()).toEqual([
      { view: 'audience', screen: HALL },
      { view: 'stage', screen: FOLDBACK },
      { view: 'singer', screen: MAIN },
    ]);
  });

  it('numbers the screen a surface landed on, so what was applied can be named back', async () => {
    const app = application();
    const placement = placementOn(opener().window, app);
    expect((await placement.place('audience', FOLDBACK, DETECTED)).screenNumber).toBe(3);
  });

  it('moves only the surface whose assignment changed', async () => {
    const { window, opened } = opener();
    const placement = placementOn(window, application());
    await placement.place('audience', HALL, DETECTED);
    await placement.place('stage', FOLDBACK, DETECTED);
    await placement.place('singer', MAIN, DETECTED);
    const before = opened.length;

    await placement.place('stage', MAIN, DETECTED);

    expect(opened.slice(before)).toEqual([
      {
        url: `${ORIGIN}/output/stage?capability=token-stage-4`,
        target: 'holydeck-output-stage',
        features: featuresOf(MAIN),
      },
    ]);
    expect(placement.assignments()).toEqual([
      { view: 'audience', screen: HALL },
      { view: 'stage', screen: MAIN },
      { view: 'singer', screen: MAIN },
    ]);
  });

  it('opens without a screen, and says so, when none is assigned to that surface', async () => {
    const { window, opened } = opener();
    const placement = placementOn(window, application());

    const result = await placement.place('singer', undefined, DETECTED);

    expect(result.applied).toBe(false);
    expect(result.refusal).toEqual({ kind: 'unassigned' });
    expect(result.launch).toEqual({ kind: 'launched', view: 'singer', placement: 'manual' });
    expect(opened[0]?.features).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// Exchanging two surfaces' screens
// ---------------------------------------------------------------------------------------------------

describe('exchanging two surfaces’ screens', () => {
  it('is one action, and neither surface is ever opened on the screen the other still holds', async () => {
    const { window, opened } = opener();
    const placement = placementOn(window, application());
    await placement.place('audience', HALL, DETECTED);
    await placement.place('stage', FOLDBACK, DETECTED);
    const before = opened.length;

    const exchanged = await placement.exchange('audience', 'stage', DETECTED);

    const during = opened.slice(before);
    expect(during).toHaveLength(2);
    // Each window is opened exactly once, directly where it ends up: there is no moment in this action
    // at which both surfaces name the same screen, which is what a swap done one assignment at a time
    // would produce.
    expect(during.map((entry) => entry.target)).toEqual(['holydeck-output-audience', 'holydeck-output-stage']);
    expect(during.map((entry) => entry.features)).toEqual([featuresOf(FOLDBACK), featuresOf(HALL)]);
    expect(new Set(during.map((entry) => entry.features)).size).toBe(2);
    expect(exchanged.map((entry) => [entry.view, entry.applied])).toEqual([
      ['audience', true],
      ['stage', true],
    ]);
    expect(placement.assignments()).toEqual([
      { view: 'audience', screen: FOLDBACK },
      { view: 'stage', screen: HALL },
      { view: 'singer', screen: undefined },
    ]);
  });

  it('exchanges with a surface that has no screen, leaving the other one unplaced', async () => {
    const { window, opened } = opener();
    const placement = placementOn(window, application());
    await placement.place('audience', HALL, DETECTED);
    const before = opened.length;

    const exchanged = await placement.exchange('audience', 'singer', DETECTED);

    expect(opened.slice(before).map((entry) => entry.features)).toEqual([undefined, featuresOf(HALL)]);
    expect(forView(exchanged, 'audience').refusal).toEqual({ kind: 'unassigned' });
    expect(forView(exchanged, 'singer').applied).toBe(true);
    expect(placement.assignments()).toEqual([
      { view: 'audience', screen: undefined },
      { view: 'stage', screen: undefined },
      { view: 'singer', screen: HALL },
    ]);
  });

  it('opens nothing at all when the server refuses either surface’s capability', async () => {
    const { window, opened } = opener();
    const app = application({ refuse: true });
    const placement = placementOn(window, app);

    const exchanged = await placement.exchange('audience', 'stage', DETECTED);

    expect(opened).toEqual([]);
    expect(exchanged.every((entry) => entry.applied === false)).toBe(true);
    expect(exchanged.map((entry) => entry.refusal?.kind)).toEqual(['not-authorized', 'not-authorized']);
  });
});

// ---------------------------------------------------------------------------------------------------
// What a reassignment during a run is not allowed to touch
// ---------------------------------------------------------------------------------------------------

/** The far side of one socket, with the three things this test moves: open it, deliver on it, read it. */
const farSide = (): {
  readonly socket: WebSocketLike;
  accept(): void;
  deliver(frame: Record<string, unknown>): void;
  sent(): readonly string[];
} => {
  const listeners = new Map<string, ((event: SocketEventLike) => void)[]>();
  const written: string[] = [];
  let readyState = 0;
  return {
    socket: {
      get readyState(): number {
        return readyState;
      },
      send: (data: string) => {
        written.push(data);
      },
      close: () => {
        readyState = 3;
      },
      addEventListener: (type, listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
    },
    accept: () => {
      readyState = 1;
      for (const listener of listeners.get('open') ?? []) listener({});
    },
    deliver: (frame) => {
      for (const listener of listeners.get('message') ?? []) listener({ data: JSON.stringify(frame) });
    },
    sent: () => written,
  };
};

/**
 * An Audience-side context as it actually exists during a run: the real live client on the audience
 * channel, and the mode state the authoritative frames it receives move. What the reassignment tests
 * read is this — not an assertion about which modules `output-placement.ts` imports, which would prove
 * nothing about what an operator's click does to a room's screen.
 */
const audienceSide = async (): Promise<{
  readonly client: LiveClient;
  readonly far: ReturnType<typeof farSide>;
  authoritative(): unknown;
}> => {
  const side = farSide();
  const client = createLiveClient({
    channel: 'audience',
    origin: ORIGIN,
    credentials: async (): Promise<LiveCredentials> => ({ kind: 'capability', capability: 'cap', service: SERVICE }),
    open: () => side.socket,
    clock: () => AT,
    retry: () => undefined,
  });
  let mode: LiveModeState<string> = initialLiveModeState('empty-screen');
  client.onEvent((event) => {
    if (event.type === 'take-live') mode = takeSelectedLive(select(mode, 'psalm-23-2'));
  });

  const connected = client.connect();
  side.accept();
  await connected;
  side.deliver({ kind: 'snapshot', channel: 'audience', stateRevision: 8, sequence: 12, at: AT });
  side.deliver({
    kind: 'event',
    channel: 'audience',
    sequence: 13,
    stateRevision: 9,
    type: 'take-live',
    mutatesState: true,
    at: AT,
  });

  return {
    client,
    far: side,
    authoritative: () => ({
      status: { ...client.status },
      mode: mode.mode,
      publicPosition: mode.publicPosition,
      selectedPosition: mode.selectedPosition,
      content: publicFrameOf(mode),
    }),
  };
};

describe('a reassignment while a service is running', () => {
  it('changes no authoritative state on the Audience side: mode, position and content are unmoved', async () => {
    const audience = await audienceSide();
    const before = structuredClone(audience.authoritative());
    const written = audience.far.sent().length;
    const placement = placementOn(opener().window, application());
    await placement.place('audience', HALL, DETECTED);

    await placement.place('audience', FOLDBACK, DETECTED);

    expect(audience.authoritative()).toEqual(before);
    expect(audience.far.sent()).toHaveLength(written);
    audience.client.close();
  });

  it('leaves the public output holding its last authoritative frame while the window moves', async () => {
    const audience = await audienceSide();
    const showing = structuredClone((audience.authoritative() as { content: unknown }).content);
    const placement = placementOn(opener().window, application());
    await placement.place('audience', HALL, DETECTED);

    await placement.exchange('audience', 'stage', DETECTED);

    expect((audience.authoritative() as { content: unknown }).content).toEqual(showing);
    expect((audience.authoritative() as { mode: string }).mode).toBe('live');
    audience.client.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// Saving with the per-device arrangement, and reopening from it
// ---------------------------------------------------------------------------------------------------

describe('saving assignments with a device’s arrangement', () => {
  it('saves what is assigned now and reopens every surface on it', async () => {
    const held = storage();
    const device = getDeviceId(held, { randomUUID: () => 'device-a' });
    const first = opener();
    const placement = placementOn(first.window, application());
    await placement.place('audience', HALL, DETECTED);
    await placement.place('stage', FOLDBACK, DETECTED);
    await placement.place('singer', MAIN, DETECTED);
    placement.save(held, device, 'sunday');

    expect(loadArrangement(held, device, 'sunday')?.screens).toEqual([HALL, FOLDBACK, MAIN]);

    const second = opener();
    const reopened = await placementOn(second.window, application()).reopen(held, device, 'sunday', DETECTED);

    expect(reopened.map((entry) => entry.applied)).toEqual([true, true, true]);
    expect(second.opened.map((entry) => entry.features)).toEqual([
      featuresOf(HALL),
      featuresOf(FOLDBACK),
      featuresOf(MAIN),
    ]);
  });

  it('keeps a second device’s arrangement independent of the first', async () => {
    const held = storage();
    const placementA = placementOn(opener().window, application());
    await placementA.place('audience', HALL, DETECTED);
    placementA.save(held, 'device-a', 'sunday');

    const placementB = placementOn(opener().window, application());
    await placementB.place('audience', MAIN, DETECTED);
    placementB.save(held, 'device-b', 'sunday');

    expect(loadArrangement(held, 'device-a', 'sunday')?.screens).toEqual([HALL]);
    expect(loadArrangement(held, 'device-b', 'sunday')?.screens).toEqual([MAIN]);
  });

  it('reopens nothing, rather than guessing, when this device saved no arrangement by that name', async () => {
    const { window, opened } = opener();
    expect(await placementOn(window, application()).reopen(storage(), 'device-a', 'sunday', DETECTED)).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('adopts what actually landed, so saving again records where the windows really are', async () => {
    const held = storage();
    const placement = placementOn(opener().window, application());
    await placement.place('audience', HALL, DETECTED);
    await placement.place('stage', FOLDBACK, DETECTED);
    placement.save(held, 'device-a', 'sunday');

    const reopened = placementOn(opener().window, application());
    await reopened.reopen(held, 'device-a', 'sunday', { kind: 'detected', screens: [MAIN, HALL] });

    expect(reopened.assignments()).toEqual([
      { view: 'audience', screen: HALL },
      { view: 'stage', screen: undefined },
      { view: 'singer', screen: undefined },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The capability an opened window presents
// ---------------------------------------------------------------------------------------------------

describe('the capability each opened window presents', () => {
  it('issues a fresh one, scoped to the surface that window shows, on every open', async () => {
    const { window, opened } = opener();
    const app = application();
    const placement = placementOn(window, app);

    await placement.place('audience', HALL, DETECTED);
    await placement.place('stage', FOLDBACK, DETECTED);

    expect(app.issues().map((call) => call.body)).toEqual([
      { service: SERVICE, view: 'audience', expiresAt: EXPIRES },
      { service: SERVICE, view: 'stage', expiresAt: EXPIRES },
    ]);
    expect(app.issues().every((call) => call.headers[CSRF_HEADER] === 'csrf-1')).toBe(true);
    expect(opened.map((entry) => entry.url)).toEqual([
      `${ORIGIN}/output/audience?capability=token-audience-1`,
      `${ORIGIN}/output/stage?capability=token-stage-2`,
    ]);
    expect(placement.holding('audience')).toEqual({
      view: 'audience',
      capabilityId: 'cap-1',
      token: 'token-audience-1',
      expiresAt: EXPIRES,
    });
  });

  it('gives up the capability a reassigned window held for its previous surface', async () => {
    const { window, opened } = opener();
    const app = application();
    const placement = placementOn(window, app);
    await placement.place('audience', HALL, DETECTED);

    const moved = await placement.place('audience', FOLDBACK, DETECTED);

    expect(app.revocations()).toEqual([capabilityPath('cap-1')]);
    expect(moved.released).toEqual({
      capability: { view: 'audience', capabilityId: 'cap-1', token: 'token-audience-1', expiresAt: EXPIRES },
      revoked: true,
    });
    expect(opened.at(-1)?.url).toBe(`${ORIGIN}/output/audience?capability=token-audience-2`);
    expect(placement.holding('audience')?.token).toBe('token-audience-2');
  });

  it('gives back the capability a blocked window never presented, and keeps the open one’s', async () => {
    const app = application();
    const placement = placementOn(opener().window, app);
    await placement.place('audience', HALL, DETECTED);

    const blocked = placementOn(opener(['audience']).window, app);
    const refused = await blocked.place('audience', FOLDBACK, DETECTED);

    expect(refused.refusal).toEqual({ kind: 'blocked' });
    // The window that is already showing Audience is untouched: only the capability nothing ever
    // presented is handed back.
    expect(app.revocations()).toEqual([capabilityPath('cap-2')]);
    expect(placement.holding('audience')?.capabilityId).toBe('cap-1');
  });

  it('refuses a capability the server issued for another surface than the one asked for', async () => {
    const { window, opened } = opener();
    const app = application({
      answering: (_view, ordinal) => ({
        token: `token-${ordinal}`,
        capabilityId: `cap-${ordinal}`,
        kind: 'output',
        service: SERVICE,
        view: 'stage',
        expiresAt: EXPIRES,
      }),
    });

    const result = await placementOn(window, app).place('audience', HALL, DETECTED);

    expect(result.applied).toBe(false);
    expect(result.refusal?.kind).toBe('not-issued');
    expect(opened).toEqual([]);
  });

  it('refuses an answer that is not a capability at all, rather than opening a window on nothing', async () => {
    const { window, opened } = opener();
    const app = application({ answering: () => ({ issued: true }) });

    const result = await placementOn(window, app).place('audience', HALL, DETECTED);

    expect(result.refusal?.kind).toBe('not-issued');
    expect(opened).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The three ways a placement fails to be applied
// ---------------------------------------------------------------------------------------------------

describe('a placement that cannot be applied', () => {
  it('degrades to the manual fallback, and reports the assignment unapplied, when detection is absent', async () => {
    const { window, opened } = opener();
    const placement = placementOn(window, application());

    const result = await placement.place('audience', HALL, ABSENT);

    expect(result.applied).toBe(false);
    expect(result.refusal).toEqual({ kind: 'detection-unavailable', reason: 'api-absent' });
    expect(result.launch).toEqual({ kind: 'launched', view: 'audience', placement: 'manual' });
    expect(opened.map((entry) => entry.features)).toEqual([undefined]);
    expect(placement.assignments()[0]).toEqual({ view: 'audience', screen: undefined });
  });

  it('degrades to the manual fallback, and reports the assignment unapplied, when the prompt was refused', async () => {
    const { window, opened } = opener();
    const placement = placementOn(window, application());

    const result = await placement.place('stage', FOLDBACK, REFUSED);

    expect(result.applied).toBe(false);
    expect(result.refusal).toEqual({ kind: 'detection-unavailable', reason: 'permission-denied' });
    expect(result.launch?.kind).toBe('launched');
    expect(opened.map((entry) => entry.features)).toEqual([undefined]);
    expect(placement.assignments()[1]).toEqual({ view: 'stage', screen: undefined });
  });

  it('degrades to the manual fallback, for that surface alone, when a saved screen is gone at reopen', async () => {
    const held = storage();
    const placement = placementOn(opener().window, application());
    await placement.place('audience', HALL, DETECTED);
    await placement.place('stage', FOLDBACK, DETECTED);
    await placement.place('singer', MAIN, DETECTED);
    placement.save(held, 'device-a', 'sunday');

    const next = opener();
    const reopened = await placementOn(next.window, application()).reopen(held, 'device-a', 'sunday', {
      kind: 'detected',
      screens: [MAIN, HALL],
    });

    expect(forView(reopened, 'stage').applied).toBe(false);
    expect(forView(reopened, 'stage').refusal).toEqual({ kind: 'screen-absent' });
    expect(forView(reopened, 'stage').launch).toEqual({ kind: 'launched', view: 'stage', placement: 'manual' });
    expect(forView(reopened, 'audience').applied).toBe(true);
    expect(forView(reopened, 'singer').applied).toBe(true);
    expect(next.opened.map((entry) => entry.features)).toEqual([featuresOf(HALL), undefined, featuresOf(MAIN)]);
  });

  it('never opens a surface on a screen nobody assigned it to, whichever way placement failed', async () => {
    const placed: (string | undefined)[] = [];
    for (const detection of [ABSENT, REFUSED, { kind: 'detected', screens: [MAIN] } as ScreenDetection]) {
      const { window, opened } = opener();
      await placementOn(window, application()).place('audience', HALL, detection);
      placed.push(...opened.map((entry) => entry.features));
    }
    expect(placed).toEqual([undefined, undefined, undefined]);
  });

  it('reports a screen that is no longer among those detected, without falling back to another one', async () => {
    const { window, opened } = opener();
    const placement = placementOn(window, application());

    const result = await placement.place('singer', HALL, { kind: 'detected', screens: [MAIN, FOLDBACK] });

    expect(result.refusal).toEqual({ kind: 'screen-absent' });
    expect(opened[0]?.features).toBeUndefined();
  });

  it('opens nothing when the server refuses this session the capability', async () => {
    const { window, opened } = opener();
    const app = application({ refuse: true });

    const result = await placementOn(window, app).place('audience', HALL, DETECTED);

    expect(result.applied).toBe(false);
    expect(result.refusal).toEqual({
      kind: 'not-authorized',
      code: 'request.forbidden',
      message: 'Control presentation is required.',
    });
    expect(result.launch).toBeUndefined();
    expect(opened).toEqual([]);
  });

  it('opens nothing on a reopen the server refuses', async () => {
    const held = storage();
    const placement = placementOn(opener().window, application());
    await placement.place('audience', HALL, DETECTED);
    placement.save(held, 'device-a', 'sunday');

    const { window, opened } = opener();
    const refusing = application({ refuse: true });
    const reopened = await placementOn(window, refusing).reopen(held, 'device-a', 'sunday', DETECTED);

    expect(opened).toEqual([]);
    expect(reopened.map((entry) => entry.refusal?.kind)).toEqual([
      'not-authorized',
      'not-authorized',
      'not-authorized',
    ]);
  });

  it('gives back what it had already been issued when a reopen is refused part-way through', async () => {
    const held = storage();
    const placement = placementOn(opener().window, application());
    await placement.place('audience', HALL, DETECTED);
    placement.save(held, 'device-a', 'sunday');

    const { window, opened } = opener();
    const refusing = application({ refuseAfter: 1 });
    const reopened = await placementOn(window, refusing).reopen(held, 'device-a', 'sunday', DETECTED);

    expect(opened).toEqual([]);
    expect(refusing.revocations()).toEqual([capabilityPath('cap-1')]);
    expect(reopened.map((entry) => entry.applied)).toEqual([false, false, false]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Naming the screens, and saying what a placement did
// ---------------------------------------------------------------------------------------------------

describe('naming the screens an operator chooses between', () => {
  it('numbers them in the order they were detected, and marks which one is the main screen', () => {
    expect(namedScreens(DETECTED, 'en')).toEqual([
      { screen: MAIN, name: 'Screen 1 (main), 1440 × 900' },
      { screen: HALL, name: 'Screen 2, 1920 × 1080' },
      { screen: FOLDBACK, name: 'Screen 3, 1280 × 720' },
    ]);
  });

  it('names them in whatever language the device resolved', () => {
    expect(namedScreens({ kind: 'detected', screens: [MAIN] }, 'de')[0]?.name).toBe('Bildschirm 1 (Haupt), 1440 × 900');
  });

  it('offers nothing to choose between when the browser listed no screens', () => {
    expect(namedScreens(ABSENT, 'en')).toEqual([]);
  });
});

describe('showing what a placement did', () => {
  const controls = (): SurfaceLaunchControls & { readonly status: { textContent: string | null } } => ({
    status: { textContent: null },
    retry: { hidden: true, onclick: null },
  });

  it('says which screen the surface opened on', async () => {
    const shown = controls();
    const placement = await placementOn(opener().window, application()).place('audience', HALL, DETECTED);

    presentPlacement(shown, placement, () => undefined, 'en');

    expect(shown.status.textContent).toBe('Audience opened on Screen 2, 1920 × 1080.');
    expect(shown.retry.hidden).toBe(true);
  });

  it('says why an assignment went unapplied, in the words of the thing that stopped it', async () => {
    const reasons = new Map<string, SurfacePlacement>();
    reasons.set('detection', await placementOn(opener().window, application()).place('audience', HALL, ABSENT));
    reasons.set(
      'screenAbsent',
      await placementOn(opener().window, application()).place('audience', HALL, { kind: 'detected', screens: [MAIN] }),
    );
    reasons.set('unassigned', await placementOn(opener().window, application()).place('audience', undefined, DETECTED));
    reasons.set(
      'notAuthorized',
      await placementOn(opener().window, application({ refuse: true })).place('audience', HALL, DETECTED),
    );

    const shown = [...reasons.values()].map((placement) => {
      const surface = controls();
      presentPlacement(surface, placement, () => undefined, 'en');
      return surface.status.textContent;
    });

    expect(shown).toEqual([
      'Audience opened without its assigned screen, because this browser did not list the screens. Drag it into place.',
      'Audience opened without its assigned screen, because that screen is no longer there. Drag it into place.',
      'Audience opened without a screen, because none is assigned to it. Drag it into place.',
      'Audience was not opened: this session may not control the presentation.',
    ]);
  });

  it('offers an action a person takes for the two refusals a second attempt can clear', async () => {
    const retry = vi.fn();
    const blocked = await placementOn(opener(['audience']).window, application()).place('audience', HALL, DETECTED);
    const unreadable = await placementOn(opener().window, application({ answering: () => ({}) })).place(
      'audience',
      HALL,
      DETECTED,
    );

    for (const placement of [blocked, unreadable]) {
      const shown = controls();
      presentPlacement(shown, placement, retry, 'en');
      expect(shown.retry.hidden).toBe(false);
      shown.retry.onclick?.();
    }
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('offers no retry for a refusal a second attempt cannot clear', async () => {
    const shown = controls();
    shown.retry.hidden = false;
    const refused = await placementOn(opener().window, application({ refuse: true })).place('audience', HALL, DETECTED);

    presentPlacement(shown, refused, () => undefined, 'en');

    expect(shown.retry.hidden).toBe(true);
    expect(shown.retry.onclick).toBeNull();
  });
});
