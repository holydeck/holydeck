// Exactly what each service in the harness stack is started with.
//
// Every variable is named here and nothing is inherited: a HOLYDECK_ variable left over in the shell
// that started the run would otherwise move the ports, the database or the library out from under the
// assertions, and the suite would be grading a developer's own stack instead of the one it started.

export interface Addresses {
  readonly appPort: number;
  readonly corpusPort: number;
  /** The MongoDB address without a database name. */
  readonly mongoBase: string;
  readonly dataDir: string;
}

/** Synthetic, and written to read as synthetic: nothing in this repository is a credential. */
export const CORPUS_TOKEN = 'harness-corpus-token-not-a-secret';

export const APP_DATABASE = 'harness_application';
export const CORPUS_DATABASE = 'harness_corpus';

// `base` may carry a query string of its own (`mongoFor()` now starts a replica set, whose URI is
// `mongodb://host:port/?replicaSet=name`), so the database name is spliced in before it rather than
// appended after — appending blindly would put `/harness_application` after the query string instead
// of before it, and the application would read that whole tail as an unnamed database.
export const applicationMongoUrl = (base: string): string => {
  const [address, query] = base.split('?');
  const path = `${(address ?? base).replace(/\/+$/u, '')}/${APP_DATABASE}`;
  return query === undefined ? path : `${path}?${query}`;
};

const settingsPath = (dataDir: string): string => `${dataDir}/config/settings.yaml`;
const mediaRoot = (dataDir: string): string => `${dataDir}/media`;
// Restic creates this itself on first `init`, the same as a real deployment's mounted repository
// directory — unlike `mediaRoot`/`config`, nothing here has to pre-create it (`stack.ts` only makes
// `media` and `config`). Left unset, both processes fall back to `settings.ts`'s own
// `CANONICAL_SETTINGS_PATH`-neighboring default, `/data/holydeck/restic`, which this harness never owns
// and a sandboxed dev machine may not even be able to write to.
const resticRepository = (dataDir: string): string => `${dataDir}/restic`;

// The services log at warn: a run that fails has to be readable, and three services at debug bury the
// one line that says why.
const LOG_LEVEL = 'warn';

export function applicationEnvironment({ appPort, corpusPort, mongoBase, dataDir }: Addresses): Record<string, string> {
  return {
    HOLYDECK_PORT: String(appPort),
    HOLYDECK_DATA_DIR: dataDir,
    HOLYDECK_MEDIA_ROOT: mediaRoot(dataDir),
    HOLYDECK_RESTIC_REPOSITORY: resticRepository(dataDir),
    HOLYDECK_LOCALE: 'en',
    HOLYDECK_CORPUS_URL: `http://127.0.0.1:${corpusPort}`,
    HOLYDECK_CORPUS_TOKEN: CORPUS_TOKEN,
    HOLYDECK_MONGO_URL: applicationMongoUrl(mongoBase),
    HOLYDECK_SETTINGS_PATH: settingsPath(dataDir),
    HOLYDECK_LOG_LEVEL: LOG_LEVEL,
  };
}

export function corpusEnvironment({ corpusPort, mongoBase }: Addresses): Record<string, string> {
  return {
    // Loopback only, the way the deployment publishes it: a library anything on the network can reach is
    // the fault the application's own boot check refuses to serve through.
    HOLYDECK_HOST: '127.0.0.1',
    HOLYDECK_PORT: String(corpusPort),
    HOLYDECK_MONGO_URL: mongoBase,
    HOLYDECK_MONGO_DB: CORPUS_DATABASE,
    HOLYDECK_CORPUS_TOKEN: CORPUS_TOKEN,
    HOLYDECK_LOG_LEVEL: LOG_LEVEL,
  };
}

export function workerEnvironment({ dataDir, mongoBase }: Addresses): Record<string, string> {
  return {
    // The one inherited variable, and only here: the worker is the one process that shells out to
    // binaries on the host (`restic`, `ffmpeg`), and an explicit `env` given to `spawn` replaces the
    // child's environment rather than merging with it, so without this `restic`/`ffmpeg` fail to resolve
    // by name at all (`spawn restic ENOENT`) rather than running against the wrong one.
    PATH: process.env.PATH ?? '',
    HOLYDECK_DATA_DIR: dataDir,
    HOLYDECK_MEDIA_ROOT: mediaRoot(dataDir),
    HOLYDECK_RESTIC_REPOSITORY: resticRepository(dataDir),
    HOLYDECK_MONGO_URL: applicationMongoUrl(mongoBase),
    HOLYDECK_SETTINGS_PATH: settingsPath(dataDir),
    HOLYDECK_LOG_LEVEL: LOG_LEVEL,
  };
}
