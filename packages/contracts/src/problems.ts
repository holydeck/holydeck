// The validation core the contracts are built from. Two properties matter more than the size of it.
// It reports every problem in a payload at once, because a boundary that rejects one field at a time
// turns a bad request into a conversation; and it never throws, because a parser that throws on the
// shape it exists to reject is a parser every caller has to wrap.

export type Problem = {
  readonly path: string;
  readonly code: string;
  readonly message: string;
};

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly Problem[] };

/** Field-level codes. Released alongside the message codes in `./http.js` and just as stable. */
export const FIELD_CODES = {
  required: 'field.required',
  empty: 'field.empty',
  notText: 'field.not_text',
  notAWholeNumber: 'field.not_a_whole_number',
  notANumber: 'field.not_a_number',
  notABoolean: 'field.not_a_boolean',
  notAList: 'field.not_a_list',
  notAnObject: 'field.not_an_object',
  notATime: 'field.not_a_time',
  notAllowed: 'field.not_allowed',
  tooSmall: 'field.too_small',
  tooLarge: 'field.too_large',
} as const;

/** The closed interval a number is read within. Both ends are allowed values, never merely approached. */
export interface Range {
  readonly minimum: number;
  readonly maximum: number;
}

/** What a share of something is, unless a caller says otherwise: none of it to all of it. */
export const UNIT_RANGE: Range = Object.freeze({ minimum: 0, maximum: 1 });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

const asText = (raw: unknown): string | undefined => (typeof raw === 'string' ? raw : undefined);

const asWholeNumber = (raw: unknown): number | undefined =>
  typeof raw === 'number' && Number.isInteger(raw) ? raw : undefined;

const asNumber = (raw: unknown): number | undefined =>
  typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;

const asFlag = (raw: unknown): boolean | undefined => (typeof raw === 'boolean' ? raw : undefined);

const asList = (raw: unknown): readonly unknown[] | undefined => (Array.isArray(raw) ? raw : undefined);

const asInstant = (raw: unknown): string | undefined => {
  const text = asText(raw);
  if (text === undefined || !INSTANT.test(text)) return undefined;
  return Number.isNaN(Date.parse(text)) ? undefined : text;
};

export type ParseFn<T> = (value: unknown, path: string) => Parsed<T>;

/**
 * Reads fields out of one payload, collecting a problem for each one it cannot accept. A rejected
 * field yields a fallback so reading can continue to the end of the payload; the fallback never
 * escapes, because `parseObject` discards the built value as soon as a single problem exists.
 */
export class FieldReader {
  readonly #source: Record<string, unknown>;
  readonly #base: string;
  readonly #problems: Problem[] = [];

  constructor(source: Record<string, unknown>, base: string) {
    this.#source = source;
    this.#base = base;
  }

  get problems(): readonly Problem[] {
    return this.#problems;
  }

  /** Every name the payload actually carried, for a rule that refuses a field it was never offered. */
  get names(): readonly string[] {
    return Object.keys(this.#source);
  }

  path(name: string): string {
    return this.#base === '' ? name : `${this.#base}.${name}`;
  }

  /** Records a problem a rule found that no field type can express, such as a missing lease. */
  reject(name: string, code: string, message: string): void {
    this.#problems.push({ path: this.path(name), code, message });
  }

  /** Records a problem when a field is present that the payload forbids. */
  absent(name: string, code: string, message: string): void {
    if (this.#source[name] !== undefined) this.reject(name, code, message);
  }

  #required<T>(name: string, fallback: T, read: (raw: unknown) => T | undefined, code: string, message: string): T {
    const raw = this.#source[name];
    if (raw === undefined) {
      this.reject(name, FIELD_CODES.required, 'is required');
      return fallback;
    }
    const value = read(raw);
    if (value === undefined) {
      this.reject(name, code, message);
      return fallback;
    }
    return value;
  }

  #optional<T>(name: string, read: (raw: unknown) => T | undefined, code: string, message: string): T | undefined {
    const raw = this.#source[name];
    if (raw === undefined) return undefined;
    const value = read(raw);
    if (value === undefined) this.reject(name, code, message);
    return value;
  }

  text(name: string): string {
    const value = this.#required(name, '', asText, FIELD_CODES.notText, 'must be text');
    if (value === '' && this.#source[name] === '') this.reject(name, FIELD_CODES.empty, 'must not be empty');
    return value;
  }

  optionalText(name: string): string | undefined {
    return this.#optional(name, asText, FIELD_CODES.notText, 'must be text');
  }

  wholeNumber(name: string, minimum = 0): number {
    const value = this.#required(name, minimum, asWholeNumber, FIELD_CODES.notAWholeNumber, 'must be a whole number');
    return this.#atLeast(name, value, minimum);
  }

  optionalWholeNumber(name: string, minimum = 0): number | undefined {
    const value = this.#optional(name, asWholeNumber, FIELD_CODES.notAWholeNumber, 'must be a whole number');
    return value === undefined ? undefined : this.#atLeast(name, value, minimum);
  }

  #atLeast(name: string, value: number, minimum: number): number {
    if (value < minimum) this.reject(name, FIELD_CODES.tooSmall, `must be at least ${minimum}`);
    return value;
  }

  /**
   * Reads a number that need not be whole, within a closed range — the reader geometry is expressed in,
   * where a coordinate is a share of the slide rather than a count of pixels nobody has measured yet.
   */
  ratio(name: string, range: Range = UNIT_RANGE): number {
    const value = this.#required(name, range.minimum, asNumber, FIELD_CODES.notANumber, 'must be a number');
    if (value < range.minimum) this.reject(name, FIELD_CODES.tooSmall, `must be at least ${range.minimum}`);
    else if (value > range.maximum) this.reject(name, FIELD_CODES.tooLarge, `must be at most ${range.maximum}`);
    return value;
  }

  flag(name: string): boolean {
    return this.#required(name, false, asFlag, FIELD_CODES.notABoolean, 'must be true or false');
  }

  optionalFlag(name: string): boolean | undefined {
    return this.#optional(name, asFlag, FIELD_CODES.notABoolean, 'must be true or false');
  }

  textList(name: string): readonly string[] {
    const raw = this.#required<readonly unknown[]>(name, [], asList, FIELD_CODES.notAList, 'must be a list');
    const values: string[] = [];
    for (const [index, item] of raw.entries()) {
      const value = asText(item);
      if (value === undefined) this.reject(`${name}.${index}`, FIELD_CODES.notText, 'must be text');
      else values.push(value);
    }
    return values;
  }

  time(name: string): string {
    return this.#required(name, '', asInstant, FIELD_CODES.notATime, 'must be a UTC instant such as 2026-09-13T09:30:00Z');
  }

  optionalTime(name: string): string | undefined {
    return this.#optional(name, asInstant, FIELD_CODES.notATime, 'must be a UTC instant such as 2026-09-13T09:30:00Z');
  }

  choice<T extends string>(name: string, allowed: readonly T[]): T {
    const read = (raw: unknown): T | undefined => allowed.find((option) => option === raw);
    return this.#required(name, allowed[0] as T, read, FIELD_CODES.notAllowed, `must be one of ${allowed.join(', ')}`);
  }

  present(name: string): unknown {
    const raw = this.#source[name];
    if (raw === undefined) this.reject(name, FIELD_CODES.required, 'is required');
    return raw;
  }

  parsed<T>(name: string, parse: ParseFn<T>, fallback: T): T {
    const raw = this.#source[name];
    if (raw === undefined) {
      this.reject(name, FIELD_CODES.required, 'is required');
      return fallback;
    }
    return this.#merge(parse(raw, this.path(name)), fallback);
  }

  optionalParsed<T>(name: string, parse: ParseFn<T>): T | undefined {
    const raw = this.#source[name];
    if (raw === undefined) return undefined;
    const parsed = parse(raw, this.path(name));
    return parsed.ok ? parsed.value : this.#merge(parsed, undefined);
  }

  parsedList<T>(name: string, parse: ParseFn<T>): readonly T[] {
    const raw = this.#required<readonly unknown[]>(name, [], asList, FIELD_CODES.notAList, 'must be a list');
    const values: T[] = [];
    for (const [index, item] of raw.entries()) {
      const parsed = parse(item, this.path(`${name}.${index}`));
      if (parsed.ok) values.push(parsed.value);
      else this.#merge(parsed, undefined);
    }
    return values;
  }

  optionalParsedList<T>(name: string, parse: ParseFn<T>): readonly T[] | undefined {
    return this.#source[name] === undefined ? undefined : this.parsedList(name, parse);
  }

  #merge<T>(parsed: Parsed<T>, fallback: T): T {
    if (parsed.ok) return parsed.value;
    this.#problems.push(...parsed.problems);
    return fallback;
  }
}

/** Reads one payload into a value, or into every reason it could not be read. */
export function parseObject<T>(value: unknown, path: string, read: (reader: FieldReader) => T): Parsed<T> {
  if (!isRecord(value)) {
    return { ok: false, problems: [{ path, code: FIELD_CODES.notAnObject, message: 'must be an object' }] };
  }
  const reader = new FieldReader(value, path);
  const built = read(reader);
  return reader.problems.length === 0 ? { ok: true, value: built } : { ok: false, problems: reader.problems };
}
