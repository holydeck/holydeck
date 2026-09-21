// The one validated settings file, with `defaults -> file -> env` precedence and the source of every
// effective value exposed, so an administrator can see which layer a value came from rather than
// guessing. The canonical file lives at CANONICAL_SETTINGS_PATH and a deployment mounts its parent
// directory, never the file itself: settings are replaced atomically, which changes the inode, and a
// file-level bind mount would keep serving the replaced one forever.

import { resolve as resolvePath } from 'node:path';

import { INTERNAL_BINDINGS, MINIMUM_CORPUS_TOKEN_LENGTH } from '@holydeck/contracts/corpus';
import { LOCALES, type Locale } from '@holydeck/localization/locales';
import { parse, stringify } from 'yaml';

import { bindingOf, corpusBinding } from './corpus.js';

export const CANONICAL_SETTINGS_PATH = '/data/holydeck/config/settings.yaml';

export interface Settings {
  port: number;
  dataDir: string;
  mediaRoot: string;
  /** Where `restic` keeps its backup repository. Configured separately from mediaRoot, on purpose. */
  resticRepository: string;
  locale: Locale;
  /** Where the corpus service answers. Empty means this deployment has no scripture library. */
  corpusUrl: string;
  /** The credential the corpus requires. Empty only alongside an empty address. */
  corpusToken: string;
  /** Where the durable records live. Empty means this deployment keeps none yet. */
  mongoUrl: string;
  /** The installation's IANA time zone. Round-trips through this loader; no scheduling reads it yet. */
  timezone: string;
  /**
   * Whether a fault of this server's own may answer with what was actually thrown.
   *
   * Off everywhere but a machine somebody is developing on, and protected rather than merely defaulted:
   * see `PROTECTED_SETTINGS` below for what that means and why this one is in it.
   */
  developmentDiagnostics: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  port: 3000,
  dataDir: '/data/holydeck',
  mediaRoot: '/data/holydeck/media',
  resticRepository: '/data/holydeck/restic',
  locale: 'en',
  corpusUrl: '',
  corpusToken: '',
  mongoUrl: '',
  timezone: 'Europe/Zurich',
  developmentDiagnostics: false,
};

/**
 * The settings this loader refuses to read out of the settings file, whatever the file says.
 *
 * Everything else here is administrable: `settings-admin.ts` merges an administrator's change into the
 * file and validates the result through this loader, so "the file accepts it" and "a signed-in account
 * holding SETTINGS_MANAGE can set it" are the same sentence. A protected setting is one where that would
 * be the wrong trade — where the value decides how much this server tells a stranger about itself, and
 * the answer should therefore need access to the deployment rather than to an account. The environment
 * is the layer only whoever runs the container can write, so it is the only layer these are read from.
 *
 * Refused loudly rather than ignored, for the reason `readFileLayer` already refuses an unknown setting:
 * a setting that looks applied and is not is worse than one that was rejected.
 */
export const PROTECTED_SETTINGS: readonly (keyof Settings)[] = ['developmentDiagnostics'];

export type SettingsSource = 'default' | 'file' | 'env';

export interface LoadedSettings {
  values: Settings;
  sources: Record<keyof Settings, SettingsSource>;
  path: string;
}

/** What kind of refusal a `SettingsError` carries: a value the schema itself rejects, or one the
 * filesystem does — a syntactically valid path this process still cannot write into. */
export type SettingsRefusal = 'invalid' | 'unwritable';

/** Carries every problem rather than the first, because a deployment fixes them in one pass. */
export class SettingsError extends Error {
  readonly problems: readonly string[];

  readonly kind: SettingsRefusal;

  constructor(problems: readonly string[], kind: SettingsRefusal = 'invalid') {
    super(`the settings are not usable:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
    this.name = 'SettingsError';
    this.problems = problems;
    this.kind = kind;
  }
}

const ENV_KEYS: Record<keyof Settings, string> = {
  port: 'HOLYDECK_PORT',
  dataDir: 'HOLYDECK_DATA_DIR',
  mediaRoot: 'HOLYDECK_MEDIA_ROOT',
  resticRepository: 'HOLYDECK_RESTIC_REPOSITORY',
  locale: 'HOLYDECK_LOCALE',
  corpusUrl: 'HOLYDECK_CORPUS_URL',
  corpusToken: 'HOLYDECK_CORPUS_TOKEN',
  mongoUrl: 'HOLYDECK_MONGO_URL',
  timezone: 'HOLYDECK_TIMEZONE',
  developmentDiagnostics: 'HOLYDECK_DEVELOPMENT_DIAGNOSTICS',
};

// Normalized so a relative or non-canonical override still matches, byte for byte, the mount table
// boot.ts's checkOwnSettingsMount reads a path out of — a bare string comparison, so an override that is
// merely equivalent rather than identical would otherwise pass unmounted.
export function settingsPath(env: Record<string, string | undefined>): string {
  const override = env.HOLYDECK_SETTINGS_PATH;
  return override === undefined ? CANONICAL_SETTINGS_PATH : resolvePath(override);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

const parsePort = (raw: unknown): Parsed<number> => {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    return { ok: false, problem: `expected a whole number between 1 and 65535, got ${JSON.stringify(raw)}` };
  }
  return { ok: true, value };
};

// Exactly the two words, and nothing that resembles either. A loader that read anything truthy as on
// would turn this on for a deployment whose variable says "no" — and the one setting parsed this way is
// the one deciding whether a stranger is shown a stack trace.
//
// Strings only, with no boolean arm, because every setting parsed here is a protected one and a
// protected setting is read from the environment alone, where a value is always text. A YAML `true` is
// refused a layer earlier, by name, rather than quietly parsed here.
const parseFlag = (raw: unknown): Parsed<boolean> => {
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  return { ok: false, problem: `expected true or false, got ${JSON.stringify(raw)}` };
};

const parseAbsolutePath = (raw: unknown): Parsed<string> => {
  if (typeof raw !== 'string' || !raw.startsWith('/')) {
    return { ok: false, problem: `expected an absolute path, got ${JSON.stringify(raw)}` };
  }
  return { ok: true, value: raw };
};

const parseLocale = (raw: unknown): Parsed<Locale> => {
  const locale = LOCALES.find((candidate) => candidate === raw);
  if (locale === undefined) {
    return { ok: false, problem: `expected one of ${LOCALES.join(', ')}, got ${JSON.stringify(raw)}` };
  }
  return { ok: true, value: locale };
};

const TIME_ZONES = new Set<string>(Intl.supportedValuesOf('timeZone'));

const parseTimezone = (raw: unknown): Parsed<string> => {
  if (typeof raw !== 'string' || !TIME_ZONES.has(raw)) {
    return { ok: false, problem: `expected an IANA time zone, got ${JSON.stringify(raw)}` };
  }
  return { ok: true, value: raw };
};

// An address the rest of the world can resolve is refused outright: the corpus holds the whole library
// and every sync job, and a deployment that can reach it from outside has already lost the argument.
const parseCorpusUrl = (raw: unknown): Parsed<string> => {
  const rejected = { ok: false, problem: `expected an http or https address, got ${JSON.stringify(raw)}` } as const;
  if (typeof raw !== 'string') return rejected;
  const value = raw.trim();
  if (value === '') return { ok: true, value: '' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return rejected;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return rejected;
  const binding = corpusBinding(value);
  if (!INTERNAL_BINDINGS.some((internal) => internal === binding)) {
    return { ok: false, problem: `expected an address inside this deployment, got ${url.hostname}` };
  }
  return { ok: true, value };
};

// The problem never carries the value: a settings error ends up in a log, and this one is a secret.
const parseCorpusToken = (raw: unknown): Parsed<string> => {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (typeof raw === 'string' && value === '') return { ok: true, value: '' };
  if (typeof raw !== 'string' || value.length < MINIMUM_CORPUS_TOKEN_LENGTH) {
    return { ok: false, problem: `expected a credential of at least ${MINIMUM_CORPUS_TOKEN_LENGTH} characters` };
  }
  return { ok: true, value };
};

// A store address is read by hand rather than by `new URL`, which cannot hold the comma-separated host
// list a replica set is written as. The problem never carries the value: the address usually carries a
// credential, and a settings error ends up in a log.
const MONGO_SCHEME = /^mongodb(?:\+srv)?:\/\//u;

const hostIn = (authority: string): string =>
  authority.replace(/^\[([^\]]*)\].*$/u, '$1').replace(/:\d+$/u, '');

const parseMongoUrl = (raw: unknown): Parsed<string> => {
  const rejected = { ok: false, problem: 'expected a mongodb:// or mongodb+srv:// address' } as const;
  if (typeof raw !== 'string') return rejected;
  const value = raw.trim();
  if (value === '') return { ok: true, value: '' };
  const scheme = MONGO_SCHEME.exec(value);
  if (scheme === null) return rejected;
  const authority = value.slice(scheme[0].length).replace(/[/?#].*$/su, '');
  // Everything up to the last at sign is the credential, and a credential is not a host.
  const hosts = authority.slice(authority.lastIndexOf('@') + 1).split(',').filter((host) => host !== '');
  if (hosts.length === 0) return rejected;
  // Without a database name the driver picks one of its own, and records land somewhere nobody looks.
  const database = value.slice(scheme[0].length + authority.length).replace(/^\//u, '').replace(/[?#].*$/su, '');
  if (database === '') return { ok: false, problem: 'expected the address to name a database' };
  for (const host of hosts) {
    const hostname = hostIn(host);
    if (!INTERNAL_BINDINGS.some((internal) => internal === bindingOf(hostname))) {
      return { ok: false, problem: `expected an address inside this deployment, got ${hostname}` };
    }
  }
  return { ok: true, value };
};

function readFileLayer(
  fileText: string | undefined,
  path: string,
  problems: string[],
): Record<string, unknown> | undefined {
  if (fileText === undefined) return undefined;
  let raw: unknown;
  try {
    raw = parse(fileText);
  } catch {
    problems.push(`${path}: is not valid YAML`);
    return undefined;
  }
  // An empty or comment-only file is what a fresh deployment mounts, and it means "use the defaults".
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`${path}: expected a mapping of settings`);
    return undefined;
  }
  const mapping = raw as Record<string, unknown>;
  for (const key of Object.keys(mapping)) {
    // A setting nobody reads is worse than a rejected one: it looks applied and is not.
    if (!(key in DEFAULT_SETTINGS)) problems.push(`${key}: unknown setting`);
  }
  for (const key of PROTECTED_SETTINGS) {
    if (!(key in mapping)) continue;
    problems.push(`${key}: is set by this deployment only, not by the settings file`);
    // Removed as well as reported, so the layer below never sees it: the load throws on this problem
    // anyway, and one refusal reads better than a refusal plus whatever the value itself would provoke.
    delete mapping[key];
  }
  return mapping;
}

interface Layers {
  file: Record<string, unknown> | undefined;
  env: Record<string, string | undefined>;
  problems: string[];
}

function resolve<T>(
  key: keyof Settings,
  fallback: T,
  parser: (raw: unknown) => Parsed<T>,
  { file, env, problems }: Layers,
): { value: T; source: SettingsSource } {
  let resolved = { value: fallback, source: 'default' as SettingsSource };
  const candidates: Array<{ source: SettingsSource; name: string; raw: unknown }> = [];
  if (file?.[key] !== undefined) candidates.push({ source: 'file', name: key, raw: file[key] });
  const fromEnv = env[ENV_KEYS[key]];
  if (fromEnv !== undefined) candidates.push({ source: 'env', name: ENV_KEYS[key], raw: fromEnv });
  for (const candidate of candidates) {
    const parsed = parser(candidate.raw);
    // The name in the message is the one the reader can act on: the setting when the file is at
    // fault, the variable when the environment is.
    if (!parsed.ok) problems.push(`${candidate.name}: ${parsed.problem}`);
    else resolved = { value: parsed.value, source: candidate.source };
  }
  return resolved;
}

export function loadSettings(input: {
  fileText?: string;
  env?: Record<string, string | undefined>;
  path?: string;
}): LoadedSettings {
  const env = input.env ?? {};
  const path = input.path ?? settingsPath(env);
  const problems: string[] = [];
  const layers: Layers = { file: readFileLayer(input.fileText, path, problems), env, problems };

  const port = resolve('port', DEFAULT_SETTINGS.port, parsePort, layers);
  const dataDir = resolve('dataDir', DEFAULT_SETTINGS.dataDir, parseAbsolutePath, layers);
  const mediaRoot = resolve('mediaRoot', DEFAULT_SETTINGS.mediaRoot, parseAbsolutePath, layers);
  const resticRepository = resolve('resticRepository', DEFAULT_SETTINGS.resticRepository, parseAbsolutePath, layers);
  const locale = resolve('locale', DEFAULT_SETTINGS.locale, parseLocale, layers);
  const corpusProblems = problems.length;
  const corpusUrl = resolve('corpusUrl', DEFAULT_SETTINGS.corpusUrl, parseCorpusUrl, layers);
  const corpusToken = resolve('corpusToken', DEFAULT_SETTINGS.corpusToken, parseCorpusToken, layers);
  // Only worth saying when both were readable: a rejected credential already said what to fix, and
  // adding "set both" to it would read as a second, separate mistake.
  if (problems.length === corpusProblems && (corpusUrl.value === '') !== (corpusToken.value === '')) {
    problems.push('corpusUrl and corpusToken: set both or neither, so the library is never read without a credential');
  }

  const mongoUrl = resolve('mongoUrl', DEFAULT_SETTINGS.mongoUrl, parseMongoUrl, layers);
  const timezone = resolve('timezone', DEFAULT_SETTINGS.timezone, parseTimezone, layers);
  const developmentDiagnostics = resolve(
    'developmentDiagnostics',
    DEFAULT_SETTINGS.developmentDiagnostics,
    parseFlag,
    layers,
  );

  if (problems.length > 0) throw new SettingsError(problems);

  return {
    values: {
      port: port.value,
      dataDir: dataDir.value,
      mediaRoot: mediaRoot.value,
      resticRepository: resticRepository.value,
      locale: locale.value,
      corpusUrl: corpusUrl.value,
      corpusToken: corpusToken.value,
      mongoUrl: mongoUrl.value,
      timezone: timezone.value,
      developmentDiagnostics: developmentDiagnostics.value,
    },
    sources: {
      port: port.source,
      dataDir: dataDir.source,
      mediaRoot: mediaRoot.source,
      resticRepository: resticRepository.source,
      locale: locale.source,
      corpusUrl: corpusUrl.source,
      corpusToken: corpusToken.source,
      mongoUrl: mongoUrl.source,
      timezone: timezone.source,
      developmentDiagnostics: developmentDiagnostics.source,
    },
    path,
  };
}

/** The fields this file holds a credential in — see `parseCorpusToken` and `parseMongoUrl` above. */
export const SETTINGS_SECRET_FIELDS: readonly (keyof Settings)[] = ['corpusToken', 'mongoUrl'];

const UNREADABLE_SETTINGS_PLACEHOLDER = '# settings file was not valid YAML; omitted from the backup\n';

/**
 * The settings file with every credential-bearing field blanked out, for the one caller that must never
 * hold onto a secret: a backup. Not run through `loadSettings`' own validation — a file already on disk
 * has already passed it once, and a backup should protect what it cannot fully parse rather than refuse
 * to run. A file this cannot parse as a mapping is replaced outright: there is nothing in it to single a
 * secret field out from, so the whole of it is withheld rather than exported unredacted.
 */
export function redactSettingsText(fileText: string): string {
  if (fileText.trim() === '') return fileText;
  let raw: unknown;
  try {
    raw = parse(fileText);
  } catch {
    return UNREADABLE_SETTINGS_PLACEHOLDER;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return UNREADABLE_SETTINGS_PLACEHOLDER;
  const mapping = raw as Record<string, unknown>;
  let redacted = false;
  for (const field of SETTINGS_SECRET_FIELDS) {
    if (typeof mapping[field] === 'string' && mapping[field] !== '') {
      // Blanked rather than marked: empty is what every reader of this file already treats as "unset",
      // for both fields, so a redacted export still loads clean instead of failing that field's own shape.
      mapping[field] = '';
      redacted = true;
    }
  }
  return redacted ? stringify(mapping) : fileText;
}
