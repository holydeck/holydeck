import { describe, expect, it } from 'vitest';

import {
  APP_DATABASE,
  CORPUS_DATABASE,
  CORPUS_TOKEN,
  applicationEnvironment,
  applicationMongoUrl,
  corpusEnvironment,
  workerEnvironment,
} from './environment.js';

const ADDRESSES = {
  appPort: 3100,
  corpusPort: 3000,
  mongoBase: 'mongodb://127.0.0.1:27017/',
  dataDir: '/tmp/holydeck-harness-test',
} as const;

describe('the environment each service in the harness stack is started with', () => {
  it('gives the application its port, its library, its credential and its database', () => {
    expect(applicationEnvironment(ADDRESSES)).toEqual({
      HOLYDECK_PORT: '3100',
      HOLYDECK_DATA_DIR: '/tmp/holydeck-harness-test',
      HOLYDECK_MEDIA_ROOT: '/tmp/holydeck-harness-test/media',
      HOLYDECK_LOCALE: 'en',
      HOLYDECK_CORPUS_URL: 'http://127.0.0.1:3000',
      HOLYDECK_CORPUS_TOKEN: CORPUS_TOKEN,
      HOLYDECK_MONGO_URL: `mongodb://127.0.0.1:27017/${APP_DATABASE}`,
      HOLYDECK_SETTINGS_PATH: '/tmp/holydeck-harness-test/config/settings.yaml',
      HOLYDECK_LOG_LEVEL: 'warn',
    });
  });

  it('binds the corpus to loopback, with a database and a credential of its own', () => {
    expect(corpusEnvironment(ADDRESSES)).toEqual({
      HOLYDECK_HOST: '127.0.0.1',
      HOLYDECK_PORT: '3000',
      HOLYDECK_MONGO_URL: 'mongodb://127.0.0.1:27017/',
      HOLYDECK_MONGO_DB: CORPUS_DATABASE,
      HOLYDECK_CORPUS_TOKEN: CORPUS_TOKEN,
      HOLYDECK_LOG_LEVEL: 'warn',
    });
  });

  it('gives the worker the mounts it owns and no port at all', () => {
    expect(workerEnvironment(ADDRESSES)).toEqual({
      HOLYDECK_DATA_DIR: '/tmp/holydeck-harness-test',
      HOLYDECK_MEDIA_ROOT: '/tmp/holydeck-harness-test/media',
      HOLYDECK_SETTINGS_PATH: '/tmp/holydeck-harness-test/config/settings.yaml',
      HOLYDECK_LOG_LEVEL: 'warn',
    });
  });

  // Exact rather than partial on purpose: a HOLYDECK_ variable left over in the shell that started the
  // run would otherwise move the ports, the database or the library out from under the assertions, and
  // the suite would be grading a developer's own stack instead of this one.
  it('inherits nothing from the shell the run was started in', () => {
    const built = [applicationEnvironment(ADDRESSES), corpusEnvironment(ADDRESSES), workerEnvironment(ADDRESSES)];
    for (const environment of built) {
      expect(Object.keys(environment).every((key) => key.startsWith('HOLYDECK_'))).toBe(true);
    }
  });

  it('names the database whether or not the address it was given ends in a slash', () => {
    expect(applicationMongoUrl('mongodb://127.0.0.1:27017/')).toBe(`mongodb://127.0.0.1:27017/${APP_DATABASE}`);
    expect(applicationMongoUrl('mongodb://127.0.0.1:27017')).toBe(`mongodb://127.0.0.1:27017/${APP_DATABASE}`);
  });
});
