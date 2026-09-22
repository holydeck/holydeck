// Proves a published CLI reaches the corpus through this deployment's own `/corpus` proxy: the same
// origin, the same bearer token, the same routes `server-client.ts` speaks. Two of the five routes the
// proxy registers — `/health` and the render route — have no CLI command wired to them yet (`doctor`
// reaches `server.health()` but also always probes bible.com, which this harness never does over the
// real network, and no command calls `ServerClient.render()`), so those two are exercised as direct,
// authenticated requests through the proxy instead of a spawned CLI process. `translations` and
// `get-verses` — which also resolves a canon lookup through `passages.ts` — are exercised through the
// real built CLI binary instead.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appendRevision, createEmptyStoreFile } from '@holydeck/core/storage';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_DATABASE, CORPUS_DATABASE, CORPUS_TOKEN } from '../src/environment.js';
import { run } from '../src/processes.js';
import { startStack } from '../src/stack.js';

import type { TranslationStoreFile } from '@holydeck/core/storage';
import type { Stack } from '../src/stack.js';

/** A built entry point, resolved from this file rather than from whatever directory the run started in. */
const entry = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

const AT = '2026-09-13T12:00:00.000Z';
const VERSES = { '1': 'O praise the LORD, all ye nations.', '2': 'Praise him, all ye people.' };
const SERMON = ['translations:', '  - KJV', 'verses:', '  - book: PSA', '    chapter: 117', '    verses: 1-2', ''].join(
  '\n',
);

/** KJV, Psalm 117, pre-loaded straight into the corpus's own store, so no test here ever reaches bible.com. */
function seedTranslation(): TranslationStoreFile {
  const file = createEmptyStoreFile('KJV', AT);
  file.meta = {
    id: 1,
    abbreviation: 'KJV',
    localAbbreviation: 'KJV',
    title: 'King James Version',
    localTitle: 'King James Version',
    language: { iso6393: 'eng', name: 'English', localName: 'English', textDirection: 'ltr', languageTag: 'en' },
    metadataBuild: 1,
  };
  file.canon = { books: [{ usfm: 'PSA', canon: 'ot', name: 'Psalms', chapters: [{ id: 'PSA.117', label: '117' }] }] };
  const { record } = appendRevision(undefined, VERSES, 2, AT);
  file.books['PSA'] = { chapters: { '117': record } };
  return file;
}

function cliEnv(dataDir: string): Record<string, string> {
  return {
    HOME: dataDir,
    XDG_CONFIG_HOME: join(dataDir, 'config'),
    XDG_DATA_HOME: join(dataDir, 'data'),
    HOLYDECK_DATA_DIR: join(dataDir, 'data'),
    HOLYDECK_SERVER_TOKEN: CORPUS_TOKEN,
    PATH: process.env['PATH'] ?? '',
  };
}

let stack: Stack;
let mongo: MongoClient;

beforeAll(async () => {
  stack = await startStack();
  // The application's own database, minus its name, is the corpus's database's own address too — the
  // stack starts one MongoDB and each service is given a different database on it.
  const mongoBase = stack.mongoUrl.replace(new RegExp(`/${APP_DATABASE}$`, 'u'), '');
  mongo = new MongoClient(mongoBase);
  await mongo.connect();
  const translations = mongo.db(CORPUS_DATABASE).collection<TranslationStoreFile & { _id: string }>('translations');
  await translations.replaceOne({ _id: 'KJV' }, seedTranslation(), { upsert: true });
});

afterAll(async () => {
  await mongo.close();
  await stack.stop();
});

describe('the CLI reaching the corpus through /corpus', () => {
  it('lists translations through the proxy, showing the one seeded as synced', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'holydeck-cli-'));
    try {
      const result = await run(
        [entry('apps/cli/dist/cli.js'), 'translations', '--server-url', `${stack.baseUrl}/corpus`, '--json'],
        cliEnv(dataDir),
      );
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.output) as {
        translations: Array<{ abbreviation: string; syncedChapters: number; canonChapters: number }>;
      };
      const kjv = parsed.translations.find((row) => row.abbreviation === 'KJV');
      expect(kjv).toMatchObject({ syncedChapters: 1, canonChapters: 1 });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('fetches verses through the proxy and renders a sermon file with them', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'holydeck-cli-'));
    const sermonPath = join(dataDir, 'sermon.yaml');
    writeFileSync(sermonPath, SERMON, 'utf8');
    try {
      const result = await run(
        [entry('apps/cli/dist/cli.js'), 'get-verses', sermonPath, '--server-url', `${stack.baseUrl}/corpus`],
        cliEnv(dataDir),
      );
      expect(result.code).toBe(0);
      expect(result.output).toContain('O praise the LORD, all ye nations. Praise him, all ye people.');
      expect(result.output).toContain('Psalms 117:1-2');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('answers a health check made straight through the proxy', async () => {
    const response = await fetch(`${stack.baseUrl}/corpus/health`, {
      headers: { authorization: `Bearer ${CORPUS_TOKEN}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; store: string };
    expect(body).toMatchObject({ status: 'ok', store: 'ok' });
  });

  it('renders a sermon posted straight to the proxy, and refuses one with no bearer token', async () => {
    const unauthorized = await fetch(`${stack.baseUrl}/corpus/api/v1/render`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: SERMON,
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${stack.baseUrl}/corpus/api/v1/render`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8', authorization: `Bearer ${CORPUS_TOKEN}` },
      body: SERMON,
    });
    expect(authorized.status).toBe(200);
    const body = (await authorized.json()) as { output: string; notices: string[] };
    expect(body.output).toContain('O praise the LORD, all ye nations. Praise him, all ye people.');
    expect(body.notices).toEqual([]);
  });
});
