import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ACCOUNTS_PATH, ONBOARDING_PATH } from '@holydeck/contracts/accounts';
import { CLIENT_VERSION_HEADER, CLIENT_WINDOW, UPDATE_REQUIRED_MESSAGE } from '@holydeck/contracts/clients';
import { MESSAGE_CODES, UPDATE_REQUIRED } from '@holydeck/contracts/http';
import { SLIDE_LAYOUTS_PATH } from '@holydeck/contracts/layouts';
import { SESSION_PATH, TICKET_PATH } from '@holydeck/contracts/sessions';
import { TOTP_PATH, TOTP_RECOVERY_PATH, TOTP_VERIFICATION_PATH } from '@holydeck/contracts/totp';
import { TRANSLATION_OFFSETS_PATH } from '@holydeck/contracts/translation-offsets';
import { PASSKEY_OPTIONS_PATH, PASSKEY_PATH } from '@holydeck/contracts/webauthn';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { VERSIONED_PREFIX, buildApp } from './app.js';
import { BACKUPS_PATH } from './backup-routes.js';
import { CAPABILITIES_PATH, GUEST_INVITATION_PATH, OUTPUT_CAPABILITY_PATH } from './capability-routes.js';
import { JOBS_PATH } from './job-routes.js';
import { MEDIA_MIGRATION_CLEANUP_PATH, MEDIA_MIGRATION_PATH } from './media-migration-routes.js';
import { NOTIFICATIONS_PATH, NOTIFICATIONS_READ_ALL_PATH, NOTIFICATIONS_PREFERENCES_PATH } from './notification-routes.js';
import { MEDIA_PATH } from './media-routes.js';
import { SHOWN_REFERENCES_PATH } from './reference-routes.js';
import { RESTORES_PATH } from './restore-routes.js';
import {
  SERVICE_DUPLICATE_PATH,
  SERVICE_ID_PATH,
  SERVICE_ITEMS_PATH,
  SERVICE_ITEMS_REORDER_PATH,
  SERVICE_ITEM_DISABLE_PATH,
  SERVICE_ITEM_DUPLICATE_PATH,
  SERVICE_ITEM_ENABLE_PATH,
  SERVICE_ITEM_PATH,
  SERVICE_ITEM_REVISE_PATH,
  SERVICE_PATH,
  SERVICE_SCHEDULE_PATH,
  SERVICE_STATUS_PATH,
  SERVICE_TRANSITION_PATH,
} from './service-routes.js';
import { SERVICE_TEMPLATE_PATH } from './service-template-routes.js';
import { SIGN_IN_REFUSED } from './session-routes.js';
import { SETTINGS_PATH } from './settings-routes.js';
import { LAYOUT_BOXES_PATH, LAYOUT_REVISIONS_PATH } from './slide-layout-routes.js';
import { UNGUARDED, mutatingRoutesOf } from './csrf.js';
import { CORPUS_WORDING, type Fetching } from './corpus.js';
import { SECURITY_HEADERS, readWebBuild } from './static.js';
import { DEFAULT_SETTINGS, type LoadedSettings } from './settings.js';

import type { InjectOptions } from 'fastify';
import type { WebAsset } from './static.js';

const sources: LoadedSettings['sources'] = {
  port: 'default',
  dataDir: 'default',
  mediaRoot: 'default',
  resticRepository: 'default',
  resticPassword: 'default',
  locale: 'file',
  corpusUrl: 'default',
  corpusToken: 'default',
  mongoUrl: 'default',
  timezone: 'default',
  developmentDiagnostics: 'default',
  backupDailyAt: 'default',
  backupComponents: 'default',
  backupMinimumGapMinutes: 'default',
  backupRehearsalWeekday: 'default',
  retentionSweepAt: 'default',
  notificationReadRetentionDays: 'default',
  autosaveRetentionDays: 'default',
  auditRetentionDays: 'default',
  mediaUploadLimitBytes: 'default',
  mediaFreeSpaceReserveBytes: 'default',
};

const settings: LoadedSettings = {
  values: { ...DEFAULT_SETTINGS, locale: 'de' },
  sources,
  path: '/data/holydeck/config/settings.yaml',
};

const withCorpus: LoadedSettings = {
  ...settings,
  values: { ...settings.values, corpusUrl: 'http://corpus:8080', corpusToken: 'a'.repeat(24) },
};

// A deployment without a library must never reach one, so the default fetch in these tests refuses.
const refusing: Fetching = () => Promise.reject(new Error('nothing in this test may leave the process'));

const served = async (
  request: { url: string; headers?: Record<string, string> },
): Promise<{ statusCode: number; body: unknown }> => {
  const app = buildApp({ settings, logger: false, fetching: refusing });
  try {
    const response = await app.inject({ method: 'GET', url: request.url, headers: request.headers });
    return { statusCode: response.statusCode, body: response.json() };
  } finally {
    await app.close();
  }
};

const current = { [CLIENT_VERSION_HEADER]: String(CLIENT_WINDOW.current) };

// The contract the guard exists for, asked of the application rather than of a test double: every route
// this server registers that changes something is one the guard saw, and every one of them refuses a
// request carrying no session. A route added without the check is absent from the first list and reachable
// in the second, and this fails either way.
describe('every route that changes something', () => {
  it('is one the session guard is on, and the list is the whole list', () => {
    const app = buildApp({ settings, logger: false, fetching: refusing });
    expect(mutatingRoutesOf(app)).toEqual([
      { method: 'DELETE', url: SESSION_PATH },
      { method: 'PATCH', url: SESSION_PATH },
      { method: 'POST', url: TICKET_PATH },
      // Served whether or not this deployment keeps accounts, so that the four changes a second factor
      // takes are counted here in every deployment rather than in only some of them.
      { method: 'POST', url: TOTP_PATH },
      { method: 'POST', url: TOTP_VERIFICATION_PATH },
      { method: 'POST', url: TOTP_RECOVERY_PATH },
      { method: 'DELETE', url: TOTP_PATH },
      { method: 'POST', url: PASSKEY_OPTIONS_PATH },
      { method: 'POST', url: PASSKEY_PATH },
      { method: 'PATCH', url: `${PASSKEY_PATH}/:id` },
      { method: 'DELETE', url: `${PASSKEY_PATH}/:id` },
      // The first route a permission gates, and not merely a proved session — still counted here, because
      // the guard it is behind is asked before the permission is.
      { method: 'PATCH', url: `${ACCOUNTS_PATH}/:id/control-presentation` },
      // Behind the same permission: creating an account, closing or reopening one, and reassigning its
      // role are all administration's, the same as granting or revoking Control presentation is.
      { method: 'POST', url: ACCOUNTS_PATH },
      { method: 'PATCH', url: `${ACCOUNTS_PATH}/:id/status` },
      { method: 'PATCH', url: `${ACCOUNTS_PATH}/:id/role` },
      // Behind the same permission as the route above: issuing or revoking a Guest's invitation or an
      // output window's capability is Control presentation's, not merely a proved session's.
      { method: 'POST', url: GUEST_INVITATION_PATH },
      { method: 'POST', url: OUTPUT_CAPABILITY_PATH },
      { method: 'DELETE', url: `${CAPABILITIES_PATH}/:capabilityId` },
      // Behind the same permission as the account surface: changing the settings file is Admin's alone.
      { method: 'PATCH', url: SETTINGS_PATH },
      // And the Layouts a service is drawn from: creating one, saving its boxes forward, bringing an
      // earlier version back and taking one out of use are all Admin's, by a permission of their own.
      { method: 'POST', url: SLIDE_LAYOUTS_PATH },
      { method: 'PUT', url: LAYOUT_BOXES_PATH },
      { method: 'POST', url: `${LAYOUT_REVISIONS_PATH}/:revision` },
      { method: 'PATCH', url: `${SLIDE_LAYOUTS_PATH}/:id/status` },
      // Behind the same permission again, by a vocabulary of its own: uploading to the media library is
      // Admin's, the same as a Slide Layout's own surface above is.
      { method: 'POST', url: MEDIA_PATH },
      // And triggering an on-demand backup: listing what has run is not a change, asking for a new one is,
      // which is why only the POST side of the backup surface is on this list.
      { method: 'POST', url: BACKUPS_PATH },
      // Behind the same permission as the backup surface: applying a recorded backup to production.
      { method: 'POST', url: RESTORES_PATH },
      // The queue's own surface, gated by its own permission: trying a failed job again is Admin's.
      // Listing what the queue holds and summarizing it are not changes and are absent here.
      { method: 'POST', url: `${JOBS_PATH}/:id/requeue` },
      // Behind its own Admin permission, by its own vocabulary: asking this deployment to migrate its
      // media storage to a new root, and cleaning up the old one afterward (OPS-16).
      { method: 'POST', url: MEDIA_MIGRATION_PATH },
      { method: 'POST', url: MEDIA_MIGRATION_CLEANUP_PATH },
      { method: 'POST', url: `${NOTIFICATIONS_PATH}/:id/read` },
      { method: 'POST', url: NOTIFICATIONS_READ_ALL_PATH },
      { method: 'POST', url: `${NOTIFICATIONS_PATH}/:id/dismiss` },
      { method: 'PUT', url: NOTIFICATIONS_PREFERENCES_PATH },
      // Behind the same permission once more: configuring a translation's offset is Admin's alone,
      // reading every one configured is not, which is why only this one route is on this list at all.
      { method: 'PUT', url: `${TRANSLATION_OFFSETS_PATH}/:abbr` },
      // The one route on this list that puts something in front of a room: looking a reference up
      // changes nothing and is absent here, and showing one is a change because it is recorded.
      { method: 'POST', url: SHOWN_REFERENCES_PATH },
      // A Service's own surface, gated by its own permission: creating one, moving it through duplication,
      // scheduling, lifecycle transition, edit or archival, and every item-level change within it — adding,
      // removing, enabling, disabling, duplicating, reordering or revising an item — are all Admin's or an
      // Editor's, never a merely-proved session's.
      { method: 'POST', url: SERVICE_PATH },
      { method: 'POST', url: SERVICE_DUPLICATE_PATH },
      { method: 'POST', url: SERVICE_SCHEDULE_PATH },
      { method: 'POST', url: SERVICE_TRANSITION_PATH },
      { method: 'PATCH', url: SERVICE_ID_PATH },
      { method: 'PATCH', url: SERVICE_STATUS_PATH },
      { method: 'POST', url: SERVICE_ITEMS_PATH },
      { method: 'DELETE', url: SERVICE_ITEM_PATH },
      { method: 'POST', url: SERVICE_ITEM_ENABLE_PATH },
      { method: 'POST', url: SERVICE_ITEM_DISABLE_PATH },
      { method: 'POST', url: SERVICE_ITEM_DUPLICATE_PATH },
      { method: 'POST', url: SERVICE_ITEMS_REORDER_PATH },
      { method: 'POST', url: SERVICE_ITEM_REVISE_PATH },
      // A Service Template is Admin's by a permission of its own: creating one changes what New Service offers.
      { method: 'POST', url: SERVICE_TEMPLATE_PATH },
    ]);
  });

  // An exception the guard declares is only sound if it names a route this application registers: a path
  // in `UNGUARDED` that nothing serves is dead text, and one that serves something else is a hole.
  it('is behind it except the two declared, which are registered and answered without a session', async () => {
    expect(UNGUARDED).toEqual([`POST ${ONBOARDING_PATH}`, `POST ${SESSION_PATH}`]);
    const app = buildApp({ settings, logger: false, fetching: refusing });
    // Neither is 401 for want of a session: the guard is on neither. The claim is not-found because this
    // deployment was handed no accounts to claim, and signing in is refused in the words every refused
    // sign-in takes — which is how a deployment with no accounts says nothing about having none.
    const claim = await app.inject({ method: 'POST', url: ONBOARDING_PATH, headers: current });
    expect(claim.statusCode).toBe(404);
    const signIn = await app.inject({ method: 'POST', url: SESSION_PATH, headers: current });
    expect(signIn.statusCode).toBe(401);
    expect(signIn.json().error.code).toBe(SIGN_IN_REFUSED);
    await app.close();
  });

  it('refuses a request that carries no session, whichever route it is', async () => {
    const app = buildApp({ settings, logger: false, fetching: refusing });
    const routes = mutatingRoutesOf(app);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      // Fastify knows one method more than its own injector does, and none of them is one this serves.
      const method = route.method as InjectOptions['method'];
      const response = await app.inject({ method, url: route.url, headers: current });
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
    await app.close();
  });
});

describe('the application server', () => {
  it('reports itself healthy in the envelope every successful response takes', async () => {
    const { statusCode, body } = await served({ url: '/health' });
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      data: { status: 'ok', locale: 'de' },
      meta: { requestId: expect.any(String), version: CLIENT_WINDOW.current },
    });
  });

  it('publishes the released message codes a client is allowed to depend on', async () => {
    const { statusCode, body } = await served({ url: '/api/contracts', headers: current });
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      data: { clientVersions: [CLIENT_WINDOW.current], messageCodes: MESSAGE_CODES },
      meta: { requestId: expect.any(String), version: CLIENT_WINDOW.current },
    });
  });

  it('answers an unknown path in the error envelope, not with the web shell and not with Fastify\'s', async () => {
    const { statusCode, body } = await served({ url: '/nope', headers: current });
    expect(statusCode).toBe(404);
    expect(body).toEqual({
      error: { code: 'resource.not_found', message: expect.any(String), requestId: expect.any(String) },
    });
  });

  it('tells a client outside the compatibility window to update, before the route is reached', async () => {
    const stale = { [CLIENT_VERSION_HEADER]: '0' };
    const { statusCode, body } = await served({ url: '/api/contracts', headers: stale });
    expect(statusCode).toBe(426);
    expect(body).toEqual({
      error: {
        code: UPDATE_REQUIRED,
        message: UPDATE_REQUIRED_MESSAGE,
        requestId: expect.any(String),
        fields: [{ path: CLIENT_VERSION_HEADER, code: UPDATE_REQUIRED, message: `supported versions: ${CLIENT_WINDOW.current}` }],
      },
    });
  });

  it('tells a client that sends no version to update rather than guessing which contract it speaks', async () => {
    const { statusCode, body } = await served({ url: '/api/contracts' });
    expect(statusCode).toBe(426);
    expect((body as { error: { code: string } }).error.code).toBe(UPDATE_REQUIRED);
  });

  it('asks for a version on the API and nowhere else, because only an API client has one to send', async () => {
    expect(VERSIONED_PREFIX).toBe('/api/');
    expect((await served({ url: '/health' })).statusCode).toBe(200);
    expect((await served({ url: '/nope' })).statusCode).toBe(404);
  });

  it('still refuses an unsupported client on an API path that does not exist, before deciding it is missing', async () => {
    const { statusCode, body } = await served({ url: '/api/nope', headers: { [CLIENT_VERSION_HEADER]: '0' } });
    expect(statusCode).toBe(426);
    expect((body as { error: { code: string } }).error.code).toBe(UPDATE_REQUIRED);
  });

  it('carries the same policy headers on an API answer as on the client it serves', async () => {
    const app = buildApp({ settings, logger: false, fetching: refusing });
    const response = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    expect(response.headers['content-security-policy']).toBe(SECURITY_HEADERS['content-security-policy']);
  });
});

describe('the web client, served from the application own origin', () => {
  let dir: string;
  let assets: ReadonlyMap<string, WebAsset>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'holydeck-app-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="en"><body><script type="module" src="/main.js"></script></body></html>');
    writeFileSync(join(dir, 'main.js'), 'export const ready = 1;\n');
    assets = readWebBuild(dir);
  });

  afterAll(() => rmSync(dir, { recursive: true }));

  const client = async (url: string): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> => {
    const app = buildApp({ settings, logger: false, fetching: refusing, web: assets });
    try {
      const response = await app.inject({ method: 'GET', url });
      return { statusCode: response.statusCode, body: response.body, headers: response.headers };
    } finally {
      await app.close();
    }
  };

  it('answers the root with the shell, with no version header sent and none needed', async () => {
    const response = await client('/');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('src="/main.js"');
  });

  it('answers the assets the shell names on the same origin it was served from', async () => {
    const response = await client('/main.js');
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('export const ready = 1;\n');
  });

  it('names no other origin anywhere in what it serves, so a client makes no cross-origin request', async () => {
    for (const url of ['/', '/main.js']) {
      const { body } = await client(url);
      expect(body, url).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}/iu);
    }
  });

  it('serves no client at all where a deployment built none', async () => {
    const { statusCode, body } = await served({ url: '/' });
    expect(statusCode).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('resource.not_found');
  });
});

describe('the translations the application reads from the library', () => {
  const list = [
    { abbreviation: 'KJV', id: 1, title: 'King James Version', language: 'English', syncedChapters: 1189, canonChapters: 1189, cached: true },
  ];

  const asked = async (
    settingsToUse: LoadedSettings,
    fetching: Fetching,
  ): Promise<{ statusCode: number; body: unknown }> => {
    const app = buildApp({ settings: settingsToUse, logger: false, fetching });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/translations', headers: current });
      return { statusCode: response.statusCode, body: response.json() };
    } finally {
      await app.close();
    }
  };

  it('answers what the library holds in the envelope every successful response takes', async () => {
    const { statusCode, body } = await asked(withCorpus, () =>
      Promise.resolve({ status: 200, json: () => Promise.resolve({ translations: list }) }),
    );
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      data: { translations: list },
      meta: { requestId: expect.any(String), version: CLIENT_WINDOW.current },
    });
  });

  it('says the library is unavailable, in its own words, when the library refuses', async () => {
    const { statusCode, body } = await asked(withCorpus, () =>
      Promise.resolve({ status: 503, json: () => Promise.resolve({ error: { code: 'store_locked', message: 'the store at /data is locked' } }) }),
    );
    expect(statusCode).toBe(503);
    expect(body).toEqual({
      error: {
        code: 'corpus.unavailable',
        message: CORPUS_WORDING['corpus.unavailable'],
        requestId: expect.any(String),
      },
    });
    expect(JSON.stringify(body)).not.toContain('/data');
  });

  it('says so plainly where no library is configured, without asking anything', async () => {
    const { statusCode, body } = await asked(settings, refusing);
    expect(statusCode).toBe(503);
    expect((body as { error: { message: string } }).error.message)
      .toBe('No scripture library is configured for this deployment.');
  });

  it('is part of the versioned API, so a client too old to read it is told to update', async () => {
    const app = buildApp({ settings: withCorpus, logger: false, fetching: refusing });
    const response = await app.inject({ method: 'GET', url: '/api/v1/translations' });
    await app.close();
    expect(response.statusCode).toBe(426);
  });
});

const canon = {
  translation: 'KJV',
  source: 'bundled',
  books: [{ usfm: 'GEN', canon: 'ot', name: 'Genesis', chapters: [{ id: '1', label: '1' }] }],
};

const verses = {
  verses: { '1': 'In the beginning God created the heaven and the earth.' },
  citation: 'Genesis 1:1 (KJV)',
  revision: 3,
  fetchedAt: '2026-09-13T09:30:00Z',
  source: 'cache',
};

const CANON_URL = 'http://corpus:8080/api/v1/translations/KJV/canon';
const VERSES_URL = 'http://corpus:8080/api/v1/translations/KJV/verses';

/** Answers by base path, ignoring the query string, so the canon call and the verses call can differ. */
function routed(byUrl: ReadonlyMap<string, { status: number; body: unknown }>): Fetching {
  return (url) => {
    const answer = byUrl.get(url.split('?')[0] ?? url) ?? { status: 500, body: {} };
    return Promise.resolve({ status: answer.status, json: () => Promise.resolve(answer.body) });
  };
}

describe('the canon the application reads from the library', () => {
  const askedCanon = async (fetching: Fetching): Promise<{ statusCode: number; body: unknown }> => {
    const app = buildApp({ settings: withCorpus, logger: false, fetching });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/translations/KJV/canon', headers: current });
      return { statusCode: response.statusCode, body: response.json() };
    } finally {
      await app.close();
    }
  };

  it('answers the canon in the envelope every successful response takes', async () => {
    const { statusCode, body } = await askedCanon(routed(new Map([[CANON_URL, { status: 200, body: canon }]])));
    expect(statusCode).toBe(200);
    expect(body).toEqual({ data: { canon }, meta: { requestId: expect.any(String), version: CLIENT_WINDOW.current } });
  });

  it('says the translation is unknown, in a named error, when the library holds none by that name', async () => {
    const { statusCode, body } = await askedCanon(routed(new Map([[CANON_URL, {
      status: 404,
      body: { error: { code: 'unknown_translation', message: 'no such translation in the registry' } },
    }]])));
    expect(statusCode).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('corpus.translation.unknown');
  });

  it('is part of the versioned API, so a client too old to read it is told to update', async () => {
    const app = buildApp({ settings: withCorpus, logger: false, fetching: refusing });
    const response = await app.inject({ method: 'GET', url: '/api/v1/translations/KJV/canon' });
    await app.close();
    expect(response.statusCode).toBe(426);
  });
});

describe('the verses the application reads from the library', () => {
  const askedVerses = async (
    fetching: Fetching,
    query = 'book=GEN&chapter=1&verses=1',
  ): Promise<{ statusCode: number; body: unknown }> => {
    const app = buildApp({ settings: withCorpus, logger: false, fetching });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/translations/KJV/verses?${query}`, headers: current });
      return { statusCode: response.statusCode, body: response.json() };
    } finally {
      await app.close();
    }
  };

  it('answers the verses in the envelope every successful response takes, the revision recorded with them', async () => {
    const fetching = routed(new Map([[CANON_URL, { status: 200, body: canon }], [VERSES_URL, { status: 200, body: verses }]]));
    const { statusCode, body } = await askedVerses(fetching);
    expect(statusCode).toBe(200);
    expect(body).toEqual({ data: { verses }, meta: { requestId: expect.any(String), version: CLIENT_WINDOW.current } });
  });

  it('passes the revision it was asked for on to the library', async () => {
    let versesUrl = '';
    const fetching: Fetching = (url) => {
      if (url.startsWith(VERSES_URL)) versesUrl = url;
      const body = url.startsWith(CANON_URL) ? canon : verses;
      return Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
    };
    await askedVerses(fetching, 'book=GEN&chapter=1&verses=1&revision=2');
    expect(versesUrl).toContain('revision=2');
  });

  it('rejects an out-of-range chapter as a named error, without asking the library for verses at all', async () => {
    const fetching = routed(new Map([[CANON_URL, { status: 200, body: canon }]]));
    const { statusCode, body } = await askedVerses(fetching, 'book=GEN&chapter=99&verses=1');
    expect(statusCode).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('corpus.reference.not_found');
  });

  it('rejects a book the canon does not hold as a named error, without asking the library for verses at all', async () => {
    const fetching = routed(new Map([[CANON_URL, { status: 200, body: canon }]]));
    const { statusCode, body } = await askedVerses(fetching, 'book=ZZZ&chapter=1&verses=1');
    expect(statusCode).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('corpus.reference.not_found');
  });

  it('surfaces the library own refusal for a verse outside the chapter, as a named error', async () => {
    const fetching = routed(new Map([
      [CANON_URL, { status: 200, body: canon }],
      [VERSES_URL, { status: 404, body: { error: { code: 'verse_not_in_store', message: 'GEN 1:99 is not stored' } } }],
    ]));
    const { statusCode, body } = await askedVerses(fetching, 'book=GEN&chapter=1&verses=99');
    expect(statusCode).toBe(404);
    expect((body as { error: { code: string } }).error.code).toBe('corpus.reference.not_found');
  });

  it('rejects a verse list it cannot read as malformed, before asking the library at all', async () => {
    const { statusCode, body } = await askedVerses(refusing, 'book=GEN&chapter=1&verses=nope');
    expect(statusCode).toBe(422);
    expect((body as { error: { code: string } }).error.code).toBe('corpus.reference.malformed');
  });

  it('rejects a request missing a required field as malformed, before asking the library at all', async () => {
    const { statusCode, body } = await askedVerses(refusing, 'book=GEN&verses=1');
    expect(statusCode).toBe(422);
    expect((body as { error: { code: string } }).error.code).toBe('corpus.reference.malformed');
  });

  it('rejects a request with no verse list at all as malformed', async () => {
    const { statusCode, body } = await askedVerses(refusing, 'book=GEN&chapter=1');
    expect(statusCode).toBe(422);
    expect((body as { error: { code: string } }).error.code).toBe('corpus.reference.malformed');
  });

  it('rejects a backwards range as malformed, before asking the library at all', async () => {
    const { statusCode, body } = await askedVerses(refusing, 'book=GEN&chapter=1&verses=4-1');
    expect(statusCode).toBe(422);
    expect((body as { error: { code: string } }).error.code).toBe('corpus.reference.malformed');
  });

  it('rejects a malformed revision as malformed, before asking the library at all', async () => {
    const { statusCode, body } = await askedVerses(refusing, 'book=GEN&chapter=1&verses=1&revision=nope');
    expect(statusCode).toBe(422);
    expect((body as { error: { code: string } }).error.code).toBe('corpus.reference.malformed');
  });

  it('rejects a repeated book parameter as malformed, before asking the library at all', async () => {
    const { statusCode, body } = await askedVerses(refusing, 'book=GEN&book=EXO&chapter=1&verses=1');
    expect(statusCode).toBe(422);
    expect((body as { error: { code: string } }).error.code).toBe('corpus.reference.malformed');
  });

  it('expands a multi-part verse list before asking the library for it', async () => {
    let versesUrl = '';
    const fetching: Fetching = (url) => {
      if (url.startsWith(VERSES_URL)) versesUrl = url;
      const body = url.startsWith(CANON_URL) ? canon : verses;
      return Promise.resolve({ status: 200, json: () => Promise.resolve(body) });
    };
    await askedVerses(fetching, 'book=GEN&chapter=1&verses=5,1-4,3');
    expect(new URL(versesUrl).searchParams.get('verses')).toBe('5,1,2,3,4,3');
  });

  it('is part of the versioned API, so a client too old to read it is told to update', async () => {
    const app = buildApp({ settings: withCorpus, logger: false, fetching: refusing });
    const response = await app.inject({ method: 'GET', url: '/api/v1/translations/KJV/verses?book=GEN&chapter=1&verses=1' });
    await app.close();
    expect(response.statusCode).toBe(426);
  });
});
