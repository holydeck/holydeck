// The half of output placement (LIVE-21) that no browser-side test can prove: that opening or
// reassigning an output window is refused by the running application, and that the capability each
// window is opened with was scoped to that one surface by the server rather than by the client.
//
// The client here is the real `output-placement.ts` module, driven against the real stack over HTTP —
// no stub of the application and no stub of the module. What it is graded on is not what it renders: a
// control a client merely hides is not an authorization, so every assertion below is made either from
// the application's own answer or from what it actually stored.
//
// Placement itself — screens, window features, the manual fallback — is proven in that module's own
// suite, which is where a browser's window management belongs. The detection handed in here is a
// fabricated two-screen one, because this suite is about the server's half.

import { MongoClient } from 'mongodb';
import { ACCOUNTS_PATH } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { createOutputPlacement } from '@holydeck/web/src/output-placement.js';
import { CSRF_HEADER } from '@holydeck/contracts/sessions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OPERATOR, signInTo } from '../src/identity.js';
import { startStack } from '../src/stack.js';

import type { RequestInitLike, ResponseLike } from '@holydeck/web/src/api.js';
import type { OutputPlacement } from '@holydeck/web/src/output-placement.js';
import type { DetectedScreen, ScreenDetection, WindowOpenerLike } from '@holydeck/web/src/output-launch.js';
import type { SignedIn } from '../src/identity.js';
import type { Stack } from '../src/stack.js';

/** What the application answers a request it will not let this session make. `apps/app/src/csrf.ts`. */
const FORBIDDEN = 'auth.forbidden';

/** Where the capability store keeps what it issued. `apps/app/src/capabilities.ts`. */
const CAPABILITIES = 'capabilities';
const ACCOUNTS = 'accounts';

const SERVICE = 'service-placement';

const MAIN: DetectedScreen = { left: 0, top: 0, width: 1440, height: 900, isPrimary: true };
const HALL: DetectedScreen = { left: 1440, top: 0, width: 1920, height: 1080, isPrimary: false };
const DETECTED: ScreenDetection = { kind: 'detected', screens: [MAIN, HALL] };

let stack: Stack;
let mongo: MongoClient;

beforeAll(async () => {
  stack = await startStack();
  mongo = new MongoClient(stack.mongoUrl);
  await mongo.connect();
});

afterAll(async () => {
  await mongo.close();
  await stack.stop();
});

/** What the server itself has on file for one capability, read outside the client that asked for it. */
const stored = async (capabilityId: string): Promise<Record<string, unknown> | null> =>
  mongo.db().collection(CAPABILITIES).findOne({ _id: capabilityId as unknown as never });

/** Every window this client opened, in order, so "nothing was opened" is a fact and not an absence. */
const opener = (): { window: WindowOpenerLike; opened: string[] } => {
  const opened: string[] = [];
  return {
    opened,
    window: {
      open(url: string): object | null {
        opened.push(url);
        return {};
      },
    },
  };
};

/**
 * `fetch` as the web client's `api.ts` expects to be handed it, plus the two things a browser adds on
 * its own and a terminal does not: the session cookie and the origin the page was served from. Nothing
 * else is added — the client version header and the CSRF token are the client's own to send, and a
 * request that arrives without them is one the application is supposed to refuse.
 */
const asking =
  (session: SignedIn) =>
  async (path: string, init: RequestInitLike): Promise<ResponseLike> => {
    const response = await fetch(`${stack.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...init.headers, cookie: session.cookie, origin: stack.baseUrl },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return { status: response.status, json: (): Promise<unknown> => response.json() };
  };

const placementFor = (session: SignedIn, window: WindowOpenerLike): OutputPlacement =>
  createOutputPlacement({
    window,
    fetching: asking(session),
    service: SERVICE,
    csrf: session.csrf,
    expiresAt: () => new Date(Date.now() + 3_600_000).toISOString(),
    urlFor: (view, token) => `${stack.baseUrl}/output/${view}?capability=${token}`,
  });

/** Grants the operator Control presentation through the route that grants it, never through the store. */
const grantControlPresentation = async (session: SignedIn): Promise<void> => {
  const account = await mongo.db().collection(ACCOUNTS).findOne({ name: OPERATOR.name });
  expect(account).not.toBeNull();
  const response = await fetch(`${stack.baseUrl}${ACCOUNTS_PATH}/${String(account?._id)}/control-presentation`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      origin: stack.baseUrl,
      cookie: session.cookie,
      [CSRF_HEADER]: session.csrf,
      [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
    },
    body: JSON.stringify({ granted: true }),
  });
  expect(response.status).toBe(200);
};

describe('opening an output window, against the running application', () => {
  it('refuses a session that may not control the presentation, and opens no window at all', async () => {
    // The harness operator is an administrator, and an administrator still does not hold Control
    // presentation: it is granted apart from role, which is the whole point of IDEN-08.
    const session = await signInTo(stack.baseUrl);
    const { window, opened } = opener();

    const placed = await placementFor(session, window).place('audience', HALL, DETECTED);

    expect(placed.applied).toBe(false);
    expect(placed.refusal).toEqual({
      kind: 'not-authorized',
      code: FORBIDDEN,
      message: expect.any(String) as unknown as string,
    });
    expect(placed.launch).toBeUndefined();
    expect(opened).toEqual([]);
    expect(await mongo.db().collection(CAPABILITIES).countDocuments({})).toBe(0);
  }, 240_000);

  it('refuses that same session a reassignment, not only a first open', async () => {
    const session = await signInTo(stack.baseUrl);
    const { window, opened } = opener();

    const exchanged = await placementFor(session, window).exchange('audience', 'stage', DETECTED);

    const refused = { kind: 'not-authorized', code: FORBIDDEN, message: expect.any(String) as unknown as string };
    expect(exchanged.map((entry) => entry.applied)).toEqual([false, false]);
    expect(exchanged.map((entry) => entry.refusal)).toEqual([refused, refused]);
    expect(opened).toEqual([]);
    expect(await mongo.db().collection(CAPABILITIES).countDocuments({})).toBe(0);
  });

  it('opens each surface holding a capability the server scoped to that one view', async () => {
    const admin = await signInTo(stack.baseUrl);
    await grantControlPresentation(admin);
    // Signed in again, because what a session may do is read from the account it was opened for.
    const operator = await signInTo(stack.baseUrl);
    const { window, opened } = opener();
    const placement = placementFor(operator, window);

    const audience = await placement.place('audience', HALL, DETECTED);
    const stage = await placement.place('stage', MAIN, DETECTED);

    expect([audience.applied, stage.applied]).toEqual([true, true]);
    expect(await stored(String(audience.capability?.capabilityId))).toMatchObject({
      kind: 'output',
      view: 'audience',
      service: SERVICE,
    });
    expect(await stored(String(stage.capability?.capabilityId))).toMatchObject({ kind: 'output', view: 'stage' });
    expect(audience.capability?.token).not.toBe(stage.capability?.token);
    expect(opened).toEqual([
      `${stack.baseUrl}/output/audience?capability=${String(audience.capability?.token)}`,
      `${stack.baseUrl}/output/stage?capability=${String(stage.capability?.token)}`,
    ]);
  });

  it('leaves a reassigned window’s previous capability unredeemable by anyone', async () => {
    const operator = await signInTo(stack.baseUrl);
    const placement = placementFor(operator, opener().window);
    const first = await placement.place('singer', HALL, DETECTED);
    const before = String(first.capability?.capabilityId);
    expect(await stored(before)).not.toBeNull();

    const moved = await placement.place('singer', MAIN, DETECTED);

    expect(moved.released?.revoked).toBe(true);
    expect(moved.released?.capability.capabilityId).toBe(before);
    // Gone from the server's own store, not merely forgotten by the client that held it: the window
    // that moved cannot present it again, and neither can anything that copied it.
    expect(await stored(before)).toBeNull();
    const now = String(moved.capability?.capabilityId);
    expect(now).not.toBe(before);
    expect(await stored(now)).toMatchObject({ kind: 'output', view: 'singer' });
  });
});
