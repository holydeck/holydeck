// What is removed from everything this service writes down, and why removing it is done here rather than
// at each place that writes.
//
// A log line, an error envelope and an audit entry are all the same thing from a secret's point of view:
// text a person other than the operator will eventually read. Redaction is therefore done on the way out
// of the process rather than at the twenty places that produce it — one reading, applied to everything,
// so a line added later is covered by the rule without anybody remembering it exists.
//
// Two rules, because neither is enough alone. A field whose name says it holds a secret is replaced
// whatever it holds, which catches the values nobody told this module about. And the secrets this
// deployment actually holds are removed wherever they turn up, which catches the field nobody named.

import type { Settings } from './settings.js';

export const REDACTED = '[redacted]';

const CIRCULAR = '[circular]';

/**
 * How long a secret has to be before it is used as a needle. A shorter one matches ordinary words, and a
 * log redacted down to nothing is a log nobody reads. Credentials that short are still removed by shape,
 * which is the other rule below, and a corpus token is refused under 24 characters before it ever gets here.
 */
export const MINIMUM_SECRET = 8;

/** The parts of a field name that say the value behind it is a secret. Parts, not substrings: `tokenizer` is not one. */
export const SECRET_NAMES: readonly string[] = Object.freeze([
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'csrf',
  'key',
  'password',
  'secret',
  'ticket',
  'token',
]);

const NAMES = new Set(SECRET_NAMES);

const partsOf = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part !== '')
    .map((part) => part.toLowerCase());

export const isSecretName = (name: string): boolean => partsOf(name).some((part) => NAMES.has(part));

// The credential in a connection string, whoever's it is: everything between the first colon after the
// scheme's authority and the at-sign that ends it.
const USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+):[^\s@]+@/gu;

// What an HTTP credential looks like when it is quoted into a message rather than carried in a header.
const CREDENTIAL = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export type Redactor = (value: unknown) => unknown;

export interface LogHooks {
  readonly logMethod: (this: unknown, args: unknown[], method: (...args: unknown[]) => void) => void;
}

/** Builds the reading every value is given on its way out, knowing the secrets this deployment holds. */
export function redactorFor(secrets: readonly string[]): Redactor {
  const needles = secrets
    .filter((secret) => secret.length >= MINIMUM_SECRET)
    .sort((left, right) => right.length - left.length)
    .map((secret) => new RegExp(escaped(secret), 'gu'));

  const scrub = (value: string): string => {
    let text = value;
    for (const needle of needles) text = text.replace(needle, REDACTED);
    return text.replace(USERINFO, `$1:${REDACTED}@`).replace(CREDENTIAL, `$1 ${REDACTED}`);
  };

  const walk = (value: unknown, open: Set<object>): unknown => {
    if (typeof value === 'string') return scrub(value);
    if (value === null || typeof value !== 'object') return value;
    const branch = value as object;
    if (open.has(branch)) return CIRCULAR;
    if (branch instanceof Date) return branch;
    if (branch instanceof Error) {
      return { name: branch.name, message: scrub(branch.message), stack: scrub(branch.stack ?? '') };
    }
    open.add(branch);
    const read = Array.isArray(branch)
      ? branch.map((item) => walk(item, open))
      : Object.fromEntries(
          Object.entries(branch).map(([name, held]) => [name, isSecretName(name) ? REDACTED : walk(held, open)]),
        );
    // Left open only for as long as this branch is being walked: the same object twice is not a loop.
    open.delete(branch);
    return read;
  };

  return (value: unknown): unknown => walk(value, new Set<object>());
}

/** The secrets a deployment holds, read off its settings rather than listed a second time by hand. */
export function secretsIn(settings: Settings): readonly string[] {
  const secrets: string[] = [];
  // Handed to Restic through a child process's environment, and a child process that dies prints its
  // environment into whatever the worker logs — so this one is read off the settings like the rest.
  if (settings.resticPassword !== '') secrets.push(settings.resticPassword);
  if (settings.corpusToken !== '') secrets.push(settings.corpusToken);
  if (settings.anthropicApiKey !== '') secrets.push(settings.anthropicApiKey);
  const stored = passwordIn(settings.mongoUrl);
  if (stored !== undefined) secrets.push(stored);
  return Object.freeze(secrets);
}

function passwordIn(url: string): string | undefined {
  const address = read(url);
  if (address === undefined || address.password === '') return undefined;
  return decodeURIComponent(address.password);
}

const read = (url: string): URL | undefined => {
  try {
    return new URL(url);
  } catch {
    // A setting that is not an address carries no credential to remove, and is not this module's to refuse.
    return undefined;
  }
};

/**
 * The logger options this service logs through. The reading is a hook rather than a list of serializers
 * because a serializer covers the fields it was told about, and a hook covers the line.
 */
export function redactingLogger(level: string, redact: Redactor): { level: string; hooks: LogHooks } {
  return {
    level,
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map((argument) => redact(argument)));
      },
    },
  };
}
