// The one validated settings file, with `defaults -> file -> env` precedence and the source of every
// effective value exposed, so an administrator can see which layer a value came from rather than
// guessing. The canonical file lives at CANONICAL_SETTINGS_PATH and a deployment mounts its parent
// directory, never the file itself: settings are replaced atomically, which changes the inode, and a
// file-level bind mount would keep serving the replaced one forever.

import { INTERNAL_BINDINGS, MINIMUM_CORPUS_TOKEN_LENGTH } from '@holydeck/contracts/corpus';
import { LOCALES, type Locale } from '@holydeck/localization/locales';
import { parse } from 'yaml';

import { corpusBinding } from './corpus.js';

export const CANONICAL_SETTINGS_PATH = '/data/holydeck/config/settings.yaml';

export interface Settings {
  port: number;
  dataDir: string;
  mediaRoot: string;
  locale: Locale;
  /** Where the corpus service answers. Empty means this deployment has no scripture library. */
  corpusUrl: string;
  /** The credential the corpus requires. Empty only alongside an empty address. */
  corpusToken: string;
}

export const DEFAULT_SETTINGS: Settings = {
  port: 3000,
  dataDir: '/data/holydeck',
  mediaRoot: '/data/holydeck/media',
  locale: 'en',
  corpusUrl: '',
  corpusToken: '',
};

export type SettingsSource = 'default' | 'file' | 'env';

export interface LoadedSettings {
  values: Settings;
  sources: Record<keyof Settings, SettingsSource>;
  path: string;
}

/** Carries every problem rather than the first, because a deployment fixes them in one pass. */
export class SettingsError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the settings are not usable:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
    this.name = 'SettingsError';
    this.problems = problems;
  }
}

const ENV_KEYS: Record<keyof Settings, string> = {
  port: 'HOLYDECK_PORT',
  dataDir: 'HOLYDECK_DATA_DIR',
  mediaRoot: 'HOLYDECK_MEDIA_ROOT',
  locale: 'HOLYDECK_LOCALE',
  corpusUrl: 'HOLYDECK_CORPUS_URL',
  corpusToken: 'HOLYDECK_CORPUS_TOKEN',
};

export function settingsPath(env: Record<string, string | undefined>): string {
  return env.HOLYDECK_SETTINGS_PATH ?? CANONICAL_SETTINGS_PATH;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

const parsePort = (raw: unknown): Parsed<number> => {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    return { ok: false, problem: `expected a whole number between 1 and 65535, got ${JSON.stringify(raw)}` };
  }
  return { ok: true, value };
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
  const locale = resolve('locale', DEFAULT_SETTINGS.locale, parseLocale, layers);
  const corpusProblems = problems.length;
  const corpusUrl = resolve('corpusUrl', DEFAULT_SETTINGS.corpusUrl, parseCorpusUrl, layers);
  const corpusToken = resolve('corpusToken', DEFAULT_SETTINGS.corpusToken, parseCorpusToken, layers);
  // Only worth saying when both were readable: a rejected credential already said what to fix, and
  // adding "set both" to it would read as a second, separate mistake.
  if (problems.length === corpusProblems && (corpusUrl.value === '') !== (corpusToken.value === '')) {
    problems.push('corpusUrl and corpusToken: set both or neither, so the library is never read without a credential');
  }

  if (problems.length > 0) throw new SettingsError(problems);

  return {
    values: {
      port: port.value,
      dataDir: dataDir.value,
      mediaRoot: mediaRoot.value,
      locale: locale.value,
      corpusUrl: corpusUrl.value,
      corpusToken: corpusToken.value,
    },
    sources: {
      port: port.source,
      dataDir: dataDir.source,
      mediaRoot: mediaRoot.source,
      locale: locale.source,
      corpusUrl: corpusUrl.source,
      corpusToken: corpusToken.source,
    },
    path,
  };
}
