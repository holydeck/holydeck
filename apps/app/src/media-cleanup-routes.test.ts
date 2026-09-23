import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { CSRF_HEADER, sessionCookie } from '@holydeck/contracts/sessions';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { accountsOn } from './accounts.js';
import { attemptsOn } from './attempts.js';
import { auditOn } from './audit.js';
import { enforceAuthorization } from './authorization.js';
import { FORBIDDEN, guardMutations, mutatingRoutesOf } from './csrf.js';
import { withSafeErrors } from './failures.js';
import { MEDIA_CLEANUP_PATH, serveMediaCleanupRoutes } from './media-cleanup-routes.js';
import { MEDIA_MANAGE } from './roles.js';
import { passkeysOn } from './passkeys.js';
import { sessionContext, sessionsOn } from './sessions.js';
import { slideGroupContext, slideGroupsOn } from './slide-groups.js';
import { totpsOn } from './totp.js';
import { memoryAccounts } from '../test/helpers/accounts.js';
import { memoryAttempts } from '../test/helpers/attempts.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { memoryPasskeys } from '../test/helpers/passkeys.js';
import { memorySessions } from '../test/helpers/sessions.js';
import { memoryTotp } from '../test/helpers/totp.js';

import type { SlideGroupBody } from '@holydeck/contracts/slide-groups';
import type { Identity } from './onboarding.js';
import type { MediaLibrary, MediaPurgeItem } from './media.js';
import type { Document } from './repositories.js';
import type { SessionStore, StartedSession } from './sessions.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FastifyInstance } from 'fastify';

const NOW = '2026-09-23T09:00:00.000Z';
const GRACE_DAYS = 180;
const ORIGIN = 'https://holydeck.example.invalid';
const HOST = 'holydeck.example.invalid';
const CORRELATION = 'req-0f9c2a41';
const ADMINISTRATOR = 'account:' + 'C'.repeat(22);
const now = (): string => NOW;

const item = (id: string, category: MediaPurgeItem['category'], over: Partial<MediaPurgeItem> = {}): MediaPurgeItem => ({
  id,
  bytes: 4096,
  type: 'image/png',
  hash: `sha256:${id}`,
  archivedAt: category === 'protected' && over.archivedAt === undefined ? undefined : '2026-01-01T00:00:00.000Z',
  category,
  reason: category === 'eligible' ? undefined : `${id} is not eligible`,
  purgeableAt: category === 'grace-period' ? '2026-06-01T00:00:00.000Z' : undefined,
  ...over,
});

let app: FastifyInstance;
let sessions: SessionStore;
let trail: FakeDb;
let identity: Identity;
let media: MediaLibrary;
let purgeReport: ReturnType<typeof vi.fn>;
let purgeArchived: ReturnType<typeof vi.fn>;
let admin: StartedSession;

const entries = (): Document[] => trail.rows.get('audit_events') ?? [];

const withHeaders = (held: StartedSession = admin) => ({
  [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current),
  host: HOST,
  'x-forwarded-proto': 'https',
  origin: ORIGIN,
  cookie: sessionCookie(held.token, 60),
  [CSRF_HEADER]: held.record.csrf,
  'content-type': 'application/json',
});

const fakeMedia = (): MediaLibrary => {
  const unused = () => { throw new Error('not used by media-cleanup-routes'); };
  purgeReport = vi.fn(async () => ({ items: [] }));
  purgeArchived = vi.fn(async () => ({ purged: [], retained: [] }));
  return {
    upload: unused,
    inspect: unused,
    list: unused,
    archive: unused,
    restore: unused,
    startProcessing: unused,
    completeProcessing: unused,
    failProcessing: unused,
    retryProcessing: unused,
    purgeReport: purgeReport as unknown as MediaLibrary['purgeReport'],
    purgeArchived: purgeArchived as unknown as MediaLibrary['purgeArchived'],
  };
};

// `db: null` (as opposed to the default, unpassed `undefined`) is this helper's own way to say "no
// content database" explicitly — a plain default parameter cannot tell "not passed" apart from
// "passed as undefined", and the fallback-to-nothing-referenced test below needs exactly that.
const served = async (missing?: 'media' | 'identity' | 'all', db: FakeDb | null = trail): Promise<FastifyInstance> => {
  const built = Fastify({ logger: false });
  withSafeErrors(built);
  guardMutations(built, { sessions });
  enforceAuthorization(built, { sessions, identity: undefined });
  serveMediaCleanupRoutes(built, {
    media: missing === 'media' || missing === 'all' ? undefined : media,
    db: db ?? undefined,
    now,
    graceDays: GRACE_DAYS,
    identity: missing === 'identity' || missing === 'all' ? undefined : identity,
  });
  await built.ready();
  return built;
};

beforeEach(async () => {
  trail = fakeDb();
  sessions = sessionsOn(memorySessions().db, { now });
  identity = {
    accounts: accountsOn(memoryAccounts().db, {
      now,
      newId: () => 'A'.repeat(22),
      hash: async (password) => `test-hash:${password}`,
      verify: async (password, stored) => stored === `test-hash:${password}`,
    }),
    audit: auditOn(trail, { now, newId: () => `e${entries().length}` }),
    attempts: attemptsOn(memoryAttempts().db, { now }),
    totp: totpsOn(memoryTotp().db, { now }),
    passkeys: passkeysOn(memoryPasskeys().db, { now }),
  };
  media = fakeMedia();
  app = await served();
  admin = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [MEDIA_MANAGE] });
});

afterEach(async () => {
  await app.close();
});

describe('the report', () => {
  test('groups items by category, sums reclaimable bytes from eligible items only, and totals each category', async () => {
    purgeReport.mockResolvedValue({
      items: [
        item('grace-1', 'grace-period'),
        item('eligible-1', 'eligible'),
        item('eligible-2', 'eligible'),
        item('live-1', 'protected', { archivedAt: undefined, reason: undefined }),
      ],
    });
    const response = await app.inject({ method: 'GET', url: MEDIA_CLEANUP_PATH, headers: withHeaders() });
    expect(response.statusCode).toBe(200);
    const body = response.json().data;
    expect(body.generatedAt).toBe(NOW);
    expect(body.totals).toEqual({ gracePeriod: 1, eligible: 2, protected: 1 });
    expect(body.reclaimableBytes).toBe(4096 * 2);
    expect(body.items.find((row: { id: string }) => row.id === 'grace-1').purgeableAt).toBe('2026-06-01T00:00:00.000Z');
    expect(purgeReport).toHaveBeenCalledWith(expect.anything(), { graceDays: GRACE_DAYS, referencedBy: expect.any(Function) });
  });

  test('an empty library reports nothing eligible', async () => {
    purgeReport.mockResolvedValue({ items: [] });
    const response = await app.inject({ method: 'GET', url: MEDIA_CLEANUP_PATH, headers: withHeaders() });
    expect(response.json().data).toMatchObject({ items: [], reclaimableBytes: 0, totals: { gracePeriod: 0, eligible: 0, protected: 0 } });
  });
});

describe('a reviewed purge', () => {
  test('purges everything currently eligible, sums purged/retained, and audits allowance once', async () => {
    purgeArchived.mockResolvedValue({ purged: ['eligible-1'], retained: [{ id: 'grace-1', reason: 'too-recent', message: 'grace-1: 10 days old' }] });
    const response = await app.inject({ method: 'POST', url: MEDIA_CLEANUP_PATH, headers: withHeaders(), payload: '{}' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      purged: ['eligible-1'],
      purgedCount: 1,
      retained: [{ id: 'grace-1', reason: 'too-recent', message: 'grace-1: 10 days old' }],
    });
    expect(purgeArchived).toHaveBeenCalledWith(expect.anything(), { graceDays: GRACE_DAYS, referencedBy: expect.any(Function) });
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({ actor: ADMINISTRATOR, action: 'media.cleanup', outcome: 'allowed' });
  });

  test('a failed audit append does not lose an accepted purge', async () => {
    purgeArchived.mockResolvedValue({ purged: ['eligible-1'], retained: [] });
    identity = { ...identity, audit: { record: vi.fn(async () => { throw new Error('trail unavailable'); }) } };
    await app.close();
    app = await served();
    const response = await app.inject({ method: 'POST', url: MEDIA_CLEANUP_PATH, headers: withHeaders(), payload: '{}' });
    expect(response.statusCode).toBe(200);
  });
});

describe('who may see the report or ask for a purge', () => {
  test('registers only the purge route behind the mutation guard', () => {
    expect(mutatingRoutesOf(app)).toEqual([{ method: 'POST', url: MEDIA_CLEANUP_PATH }]);
  });

  test.each([
    ['GET', MEDIA_CLEANUP_PATH],
    ['POST', MEDIA_CLEANUP_PATH],
  ] as const)('refuses %s %s without media.manage', async (method, url) => {
    const guest = await sessions.start(sessionContext(CORRELATION), { actor: ADMINISTRATOR, permissions: [] });
    const response = await app.inject({ method, url, headers: withHeaders(guest), payload: method === 'POST' ? '{}' : undefined });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe(FORBIDDEN);
  });

  test.each(['media', 'identity', 'all'] as const)('answers not-found without %s', async (missing) => {
    await app.close();
    app = await served(missing);
    for (const [method, url] of [['GET', MEDIA_CLEANUP_PATH], ['POST', MEDIA_CLEANUP_PATH]] as const) {
      const response = await app.inject({ method, url, headers: withHeaders(), payload: method === 'POST' ? '{}' : undefined });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe('what referencedBy actually resolves (OPS-14)', () => {
  const SLIDE = { id: 'slide-1', enabled: true, label: 'Welcome', languageBlocks: [] };
  const bodyWithBackground: SlideGroupBody = { mode: 'custom', enabled: true, slideLayoutId: 'layout-a', background: 'asset-1', slides: [SLIDE] };
  const bodyWithAudio: SlideGroupBody = { mode: 'custom', enabled: true, slideLayoutId: 'layout-a', audioTrackId: 'asset-1', slides: [SLIDE] };
  const bodyReusable: SlideGroupBody = {
    mode: 'custom',
    enabled: true,
    slideLayoutId: 'layout-a',
    slides: [{ ...SLIDE, background: 'asset-2' }],
  };

  test('resolves real slide group and reusable slide references, not an always-empty stub', async () => {
    let nextId = 0;
    const groups = slideGroupsOn(trail, { now, newId: () => `slide-group-${(nextId += 1)}` });
    const context = slideGroupContext(ADMINISTRATOR, CORRELATION);
    const withBackground = await groups.create(context, 'slideGroup', 'Background', bodyWithBackground);
    const withAudio = await groups.create(context, 'slideGroup', 'Audio', bodyWithAudio);
    const reusable = await groups.create(context, 'reusableSlide', 'Reusable', bodyReusable);

    purgeReport.mockResolvedValue({ items: [] });
    const response = await app.inject({ method: 'GET', url: MEDIA_CLEANUP_PATH, headers: withHeaders() });
    expect(response.statusCode).toBe(200);
    const referencedBy = purgeReport.mock.calls.at(-1)?.[1].referencedBy as (assetId: string) => readonly string[];
    expect(referencedBy('asset-1')).toEqual([`slideGroup:${withBackground.stamp.id}`, `slideGroup:${withAudio.stamp.id}`]);
    expect(referencedBy('asset-2')).toEqual([`reusableSlide:${reusable.stamp.id}`]);
    expect(referencedBy('asset-3')).toEqual([]);
  });

  test('falls back to reporting nothing referenced when this deployment has no content database', async () => {
    await app.close();
    app = await served(undefined, null);
    purgeReport.mockResolvedValue({ items: [] });
    await app.inject({ method: 'GET', url: MEDIA_CLEANUP_PATH, headers: withHeaders() });
    const referencedBy = purgeReport.mock.calls.at(-1)?.[1].referencedBy as (assetId: string) => readonly string[];
    expect(referencedBy('asset-1')).toEqual([]);
  });
});
