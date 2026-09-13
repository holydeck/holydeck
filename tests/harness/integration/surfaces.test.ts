// The integration layer. One isolated stack — a MongoDB of its own, the corpus, the migration, the
// application and the worker, all started from the built packages — and every surface the
// specification names is reached through it: the same-origin application, MongoDB, a WebSocket client
// and worker jobs. Nothing here reaches into a package's internals; every assertion is made from
// outside, the way a deployment is.

import { MongoClient } from 'mongodb';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW, UPDATE_REQUIRED_MESSAGE, UPDATE_REQUIRED_STATUS } from '@holydeck/contracts/clients';
import { UPDATE_REQUIRED } from '@holydeck/contracts/http';
import { parseSnapshotFrame } from '@holydeck/contracts/live';
import { SESSION_PATH, TICKET_QUERY } from '@holydeck/contracts/sessions';
import { readJob } from '@holydeck/worker/jobs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OPERATOR, signInTo } from '../src/identity.js';
import { reachLedger } from '../src/reach.js';
import { startStack } from '../src/stack.js';

import type { SignedIn } from '../src/identity.js';
import type { Stack } from '../src/stack.js';

const CLIENT = { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) };
const JOBS = 'harness_jobs';
const AT = '2026-09-13T12:00:00.000Z';
const LATER = '2026-09-13T12:05:00.000Z';

// The queue's own collection and lifecycle belong to the task that builds it; what this suite proves is
// that a record really stored in MongoDB is read back through the boundary the worker reads jobs at.
const LEASED = {
  id: 'job:9f2c',
  kind: 'media-probe',
  idempotencyKey: 'media-probe:9f2c',
  state: 'leased',
  attempt: 1,
  retryLimit: 3,
  queuedAt: AT,
  workers: ['worker:1'],
  leaseExpiresAt: LATER,
  heartbeatAt: AT,
};

const ledger = reachLedger();

let stack: Stack;
let operator: SignedIn;

beforeAll(async () => {
  stack = await startStack();
  // A stack that keeps records keeps sessions, so every socket it serves is opened by spending a ticket.
  // The run claims the instance it just started and signs in, which is what a person does to open one.
  operator = await signInTo(stack.baseUrl);
});

afterAll(async () => {
  await stack.stop();
  // Belt and braces on top of the last test below: a filtered run, or one that stopped early, must not
  // report success for surfaces it never touched.
  ledger.assertEveryRequiredSurface();
});

/** One live session, recording what arrived so an assertion can wait for it rather than poll. */
function session(path: string, headers: Record<string, string>): {
  closed: Promise<{ code: number; reason: string }>;
  open: Promise<void>;
  send(frame: unknown): void;
  next(): Promise<unknown>;
  close(): void;
} {
  const socket = new WebSocket(`${stack.baseUrl.replace(/^http/u, 'ws')}${path}`, { headers });
  const frames: unknown[] = [];
  const waiting: Array<(frame: unknown) => void> = [];
  socket.addEventListener('message', (event: MessageEvent) => {
    const frame: unknown = JSON.parse(String(event.data));
    const waiter = waiting.shift();
    // Delivered or queued, never both: a frame left in the queue after an assertion already read it is
    // the frame the next assertion reads, and it passes for the wrong reason.
    if (waiter === undefined) frames.push(frame);
    else waiter(frame);
  });
  return {
    open: new Promise((resolve) => socket.addEventListener('open', () => resolve())),
    closed: new Promise((resolve) =>
      socket.addEventListener('close', (event: CloseEvent) => resolve({ code: event.code, reason: event.reason })),
    ),
    send: (frame) => socket.send(JSON.stringify(frame)),
    next: () =>
      new Promise((resolve) => {
        const arrived = frames.shift();
        if (arrived !== undefined) resolve(arrived);
        else waiting.push(resolve);
      }),
    close: () => socket.close(),
  };
}

/**
 * A socket the way a page opens one: the session in the cookie, the origin the page was served from,
 * and a ticket spent in the query string, which is the only place a browser socket can carry anything.
 */
const live = async (query: string): Promise<ReturnType<typeof session>> =>
  session(`/api/v1/live?${query}&${TICKET_QUERY}=${await operator.ticket()}`, {
    origin: stack.baseUrl,
    cookie: operator.cookie,
  });

describe('the same-origin application', () => {
  it('answers its health check with the locale this deployment was configured for', async () => {
    const response = await fetch(`${stack.baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { status: 'ok', locale: 'en' } });
    ledger.reached('application', 'health answered with the configured locale');
  });

  it('serves the built web client from its own origin, under the policy it publishes', async () => {
    const response = await fetch(`${stack.baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // The client's live session is a same-origin connection, so the policy it is served under has to
    // allow one; a stricter connect-src would be found as a console error in front of a congregation.
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    const html = await response.text();
    expect(html).toContain('<h1>HolyDeck</h1>');
    expect(html).toContain('<script type="module" src="/main.js">');
    const bundle = await fetch(`${stack.baseUrl}/main.js`);
    expect(bundle.status).toBe(200);
    ledger.reached('application', 'the built client was served same-origin');
  });

  it('reads the library through its internal client, with a credential the client never sees', async () => {
    const response = await fetch(`${stack.baseUrl}/api/v1/translations`, { headers: CLIENT });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { translations: readonly { abbreviation: string }[] } };
    expect(body.data.translations.length).toBeGreaterThan(0);
    ledger.reached('application', `the library answered through the internal client with ${body.data.translations.length} translations`);
  });

  it('keeps the corpus closed to anything that reaches it without a credential', async () => {
    const direct = await fetch(`${stack.corpusUrl}/api/v1/translations`);
    expect(direct.status).toBe(401);
  });

  it('tells a client this build cannot serve to update, rather than answering it', async () => {
    const response = await fetch(`${stack.baseUrl}/api/v1/translations`, {
      headers: { [CLIENT_VERSION_HEADER]: '99' },
    });
    expect(response.status).toBe(UPDATE_REQUIRED_STATUS);
    expect(await response.json()).toMatchObject({ error: { code: UPDATE_REQUIRED, message: UPDATE_REQUIRED_MESSAGE } });
  });
});

describe('MongoDB', () => {
  let client: MongoClient;

  beforeAll(async () => {
    client = new MongoClient(stack.mongoUrl);
    await client.connect();
  });

  afterAll(async () => {
    await client.close();
  });

  it('holds the migration ledger the application refused to start without', async () => {
    const rows = await client.db().collection('schema_migrations').find({}, { projection: { _id: 0 } }).toArray();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ version: 1, direction: 'up', phase: 'done' })]),
    );
    ledger.reached('mongo', `the schema ledger holds ${rows.length} entries the migration wrote`);
  });

  it('holds the indexes the immutable records are read by', async () => {
    const indexes = await client.db().collection('run_events').indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'run_order', unique: true })]),
    );
    ledger.reached('mongo', 'the run-order index the migration built is on the database');
  });
});

describe('a live WebSocket client', () => {
  it('is answered with a snapshot of the channel it asked for', async () => {
    const socket = await live(`channel=live-control&clientVersion=${CLIENT_WINDOW.current}`);
    const parsed = parseSnapshotFrame(await socket.next());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toMatchObject({ kind: 'snapshot', channel: 'live-control', sequence: 0 });
    socket.close();
    await socket.closed;
    ledger.reached('websocket', 'a ticket from a signed-in session opened live-control with a snapshot');
  });

  it('answers a resume from the sequence the client last saw', async () => {
    const socket = await live(`channel=stage&clientVersion=${CLIENT_WINDOW.current}`);
    await socket.next();
    socket.send({ kind: 'resume', channel: 'stage', fromSequence: 7 });
    expect(await socket.next()).toMatchObject({ kind: 'snapshot', channel: 'stage', sequence: 7 });
    socket.close();
    await socket.closed;
    ledger.reached('websocket', 'a resume was answered from the sequence the client named');
  });

  it('refuses a client version it cannot serve, with a reason the client can read', async () => {
    const socket = await live('channel=audience&clientVersion=99');
    expect(await socket.closed).toMatchObject({ code: 1008 });
    expect((await socket.closed).reason).toContain(UPDATE_REQUIRED_MESSAGE);
  });

  // The other half of the same rule, proven from outside: a ticket is what a socket costs, and a client
  // that has none is refused before it is a socket at all rather than answered a frame.
  it('refuses a client that spent no ticket, whatever channel it asked for', async () => {
    const socket = session(`/api/v1/live?channel=stage&clientVersion=${CLIENT_WINDOW.current}`, {});
    expect(await socket.closed).toMatchObject({ code: 1006 });
    ledger.reached('websocket', 'a socket opened with no ticket was refused before the upgrade');
  });
});

// The stopwatch the unit suite deliberately left to this one. What a password costs is scrypt at the
// cost this deployment stores, and the whole point of deriving against a decoy for a handle nobody holds
// is that the two answers cost the same — so the measurement has to be made where the derivation is the
// real one, against a real database, over HTTP.
describe('signing in', () => {
  const attempt = async (name: string, password: string): Promise<{ status: number; ms: number }> => {
    const started = performance.now();
    const response = await fetch(`${stack.baseUrl}${SESSION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stack.baseUrl, ...CLIENT },
      body: JSON.stringify({ name, password }),
    });
    await response.text();
    return { status: response.status, ms: performance.now() - started };
  };

  const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

  it('costs a handle nobody holds what it costs a handle somebody does, and says the same thing', async () => {
    // The decoy credential is derived once, on the first miss, and kept: that one derivation is this
    // deployment's start-up cost, not an attempt's, so it is paid before anything is timed.
    await attempt('warming-up', OPERATOR.password);

    const wrong: number[] = [];
    const unknown: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const known = await attempt(OPERATOR.name, 'not-the-passphrase');
      const nobody = await attempt('nobody-holds-this', OPERATOR.password);
      expect([known.status, nobody.status]).toEqual([401, 401]);
      wrong.push(known.ms);
      unknown.push(nobody.ms);
    }

    const known = median(wrong);
    const nobody = median(unknown);
    // Both paid for a derivation rather than one being answered from an index miss: at this cost, an
    // answer that skipped scrypt comes back in single-digit milliseconds.
    expect(Math.min(known, nobody)).toBeGreaterThan(20);
    // Within half of the slower of the two, which is the tolerance a shared runner can hold. An answer
    // that told the two apart would differ by the whole of a derivation, not by a fraction of one.
    expect(Math.abs(known - nobody)).toBeLessThan(Math.max(known, nobody) / 2);
    ledger.reached('application', `a miss cost ${Math.round(nobody)}ms against a hit's ${Math.round(known)}ms`);
  });

  // Five failures are under the limit and the successful sign-in clears them, which is what keeps the
  // rest of this run — and the browser run against the same stack — signing in at all.
  it('forgives what was counted against a handle as soon as that handle signs in', async () => {
    await expect(attempt(OPERATOR.name, OPERATOR.password)).resolves.toMatchObject({ status: 201 });
  });
});

describe('the worker', () => {
  it('writes a heartbeat its own health check accepts', async () => {
    const health = await stack.workerHealth();
    expect(health).toMatchObject({ code: 0 });
    ledger.reached('worker', 'the worker health command exited 0 against the heartbeat it wrote');
  });

  it('reads a leased job back out of MongoDB through the boundary it runs jobs from', async () => {
    const client = new MongoClient(stack.mongoUrl);
    await client.connect();
    try {
      await client.db().collection(JOBS).insertOne({ ...LEASED });
      const stored = await client.db().collection(JOBS).findOne({ id: LEASED.id }, { projection: { _id: 0 } });
      const runnable = readJob(stored, AT);
      expect(runnable).toMatchObject({ ok: true, job: { id: LEASED.id, state: 'leased' } });
      // The same record after its lease has run out: the worker refuses it rather than running a job a
      // second worker may already have reclaimed.
      expect(readJob(stored, '2026-09-13T12:06:00.000Z')).toEqual({
        ok: false,
        reasons: [`${LEASED.id}: the lease ran out at ${LATER}`],
      });
      ledger.reached('worker', 'a leased job stored in MongoDB was read back and an expired lease refused');
    } finally {
      await client.close();
    }
  });
});

// Last, and deliberately an assertion rather than a report: the run has no value if it exercised three
// of the four surfaces, and the report is what the evidence for this task quotes.
it('reached every surface this harness requires', () => {
  expect(ledger.missing()).toEqual([]);
  expect(ledger.report()).not.toContain('not reached');
  console.info(ledger.report());
});
