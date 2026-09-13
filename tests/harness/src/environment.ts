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

export const applicationMongoUrl = (base: string): string => `${base.replace(/\/+$/u, '')}/${APP_DATABASE}`;

const settingsPath = (dataDir: string): string => `${dataDir}/config/settings.yaml`;
const mediaRoot = (dataDir: string): string => `${dataDir}/media`;

// The services log at warn: a run that fails has to be readable, and three services at debug bury the
// one line that says why.
const LOG_LEVEL = 'warn';

export function applicationEnvironment({ appPort, corpusPort, mongoBase, dataDir }: Addresses): Record<string, string> {
  return {
    HOLYDECK_PORT: String(appPort),
    HOLYDECK_DATA_DIR: dataDir,
    HOLYDECK_MEDIA_ROOT: mediaRoot(dataDir),
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

export function workerEnvironment({ dataDir }: Addresses): Record<string, string> {
  return {
    HOLYDECK_DATA_DIR: dataDir,
    HOLYDECK_MEDIA_ROOT: mediaRoot(dataDir),
    HOLYDECK_SETTINGS_PATH: settingsPath(dataDir),
    HOLYDECK_LOG_LEVEL: LOG_LEVEL,
  };
}
