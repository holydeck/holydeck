import { describe, expect, it } from 'vitest';

import { FIELD_CODES, FieldReader, isRecord, parseObject } from './problems.js';

type Person = { readonly name: string; readonly age: number };

const readPerson = (reader: FieldReader): Person => ({
  name: reader.text('name'),
  age: reader.wholeNumber('age', 0),
});

const parsePerson = (value: unknown, path: string) => parseObject(value, path, readPerson);

describe('isRecord', () => {
  it('accepts a plain object and refuses everything a plain object is confused with', () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('{}')).toBe(false);
  });
});

describe('parseObject', () => {
  it('returns the value it built when every field is acceptable', () => {
    expect(parsePerson({ name: 'Ada', age: 36 }, 'person')).toEqual({
      ok: true,
      value: { name: 'Ada', age: 36 },
    });
  });

  it('reports every problem at once rather than stopping at the first', () => {
    expect(parsePerson({ age: 'old' }, 'person')).toEqual({
      ok: false,
      problems: [
        { path: 'person.name', code: FIELD_CODES.required, message: 'is required' },
        { path: 'person.age', code: FIELD_CODES.notAWholeNumber, message: 'must be a whole number' },
      ],
    });
  });

  it('names the value itself when it is not an object at all', () => {
    expect(parsePerson('Ada', 'person')).toEqual({
      ok: false,
      problems: [{ path: 'person', code: FIELD_CODES.notAnObject, message: 'must be an object' }],
    });
  });

  it('leaves the path empty when the value is the whole payload', () => {
    const parsed = parseObject({}, '', readPerson);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.problems[0]?.path).toBe('name');
  });
});

describe('FieldReader', () => {
  const problemsOf = (source: Record<string, unknown>, read: (reader: FieldReader) => unknown): readonly string[] => {
    const reader = new FieldReader(source, 'payload');
    read(reader);
    return reader.problems.map((problem) => `${problem.path}: ${problem.code}`);
  };

  it('reads text and refuses anything that is not text', () => {
    expect(new FieldReader({ a: 'x' }, '').text('a')).toBe('x');
    expect(problemsOf({ a: 7 }, (reader) => reader.text('a'))).toEqual(['payload.a: field.not_text']);
    expect(problemsOf({ a: '' }, (reader) => reader.text('a'))).toEqual(['payload.a: field.empty']);
    expect(problemsOf({}, (reader) => reader.text('a'))).toEqual(['payload.a: field.required']);
  });

  it('treats an absent optional field as absent and still refuses a wrong one', () => {
    expect(new FieldReader({}, '').optionalText('a')).toBeUndefined();
    expect(new FieldReader({ a: 'x' }, '').optionalText('a')).toBe('x');
    expect(problemsOf({ a: 7 }, (reader) => reader.optionalText('a'))).toEqual(['payload.a: field.not_text']);
  });

  it('reads whole numbers and refuses fractions, other types, and anything under the minimum', () => {
    expect(new FieldReader({ a: 3 }, '').wholeNumber('a', 0)).toBe(3);
    expect(new FieldReader({ a: 0 }, '').wholeNumber('a')).toBe(0);
    expect(problemsOf({ a: 1.5 }, (reader) => reader.wholeNumber('a'))).toEqual(['payload.a: field.not_a_whole_number']);
    expect(problemsOf({ a: '3' }, (reader) => reader.wholeNumber('a'))).toEqual(['payload.a: field.not_a_whole_number']);
    expect(problemsOf({ a: 0 }, (reader) => reader.wholeNumber('a', 1))).toEqual(['payload.a: field.too_small']);
    expect(problemsOf({}, (reader) => reader.wholeNumber('a'))).toEqual(['payload.a: field.required']);
    expect(new FieldReader({}, '').optionalWholeNumber('a')).toBeUndefined();
    expect(new FieldReader({ a: 2 }, '').optionalWholeNumber('a', 1)).toBe(2);
    expect(problemsOf({ a: 0 }, (reader) => reader.optionalWholeNumber('a', 1))).toEqual(['payload.a: field.too_small']);
  });

  it('reads a number that need not be whole and refuses one outside the range it is a share of', () => {
    expect(new FieldReader({ a: 0.25 }, '').ratio('a')).toBe(0.25);
    expect(new FieldReader({ a: 1 }, '').ratio('a')).toBe(1);
    expect(problemsOf({ a: '0.25' }, (reader) => reader.ratio('a'))).toEqual(['payload.a: field.not_a_number']);
    expect(problemsOf({ a: Number.NaN }, (reader) => reader.ratio('a'))).toEqual(['payload.a: field.not_a_number']);
    expect(problemsOf({ a: Number.POSITIVE_INFINITY }, (reader) => reader.ratio('a'))).toEqual([
      'payload.a: field.not_a_number',
    ]);
    expect(problemsOf({ a: -0.1 }, (reader) => reader.ratio('a'))).toEqual(['payload.a: field.too_small']);
    expect(problemsOf({ a: 1.5 }, (reader) => reader.ratio('a'))).toEqual(['payload.a: field.too_large']);
    expect(new FieldReader({ a: 1.4 }, '').ratio('a', { minimum: 1, maximum: 4 })).toBe(1.4);
    expect(problemsOf({}, (reader) => reader.ratio('a'))).toEqual(['payload.a: field.required']);
  });

  it('reads a flag and refuses a value that merely looks true', () => {
    expect(new FieldReader({ a: false }, '').flag('a')).toBe(false);
    expect(problemsOf({ a: 'true' }, (reader) => reader.flag('a'))).toEqual(['payload.a: field.not_a_boolean']);
    expect(problemsOf({}, (reader) => reader.flag('a'))).toEqual(['payload.a: field.required']);
  });

  it('reads a list of text and refuses a list holding anything else', () => {
    expect(new FieldReader({ a: ['x'] }, '').textList('a')).toEqual(['x']);
    expect(new FieldReader({ a: [] }, '').textList('a')).toEqual([]);
    expect(problemsOf({ a: 'x' }, (reader) => reader.textList('a'))).toEqual(['payload.a: field.not_a_list']);
    expect(problemsOf({ a: [1] }, (reader) => reader.textList('a'))).toEqual(['payload.a.0: field.not_text']);
    expect(problemsOf({}, (reader) => reader.textList('a'))).toEqual(['payload.a: field.required']);
  });

  it('reads an instant and refuses a shape that is not one, a date that does not exist, and a local time', () => {
    expect(new FieldReader({ a: '2026-09-13T09:30:00Z' }, '').time('a')).toBe('2026-09-13T09:30:00Z');
    expect(new FieldReader({ a: '2026-09-13T09:30:00.250Z' }, '').time('a')).toBe('2026-09-13T09:30:00.250Z');
    expect(problemsOf({ a: '13.09.2026' }, (reader) => reader.time('a'))).toEqual(['payload.a: field.not_a_time']);
    expect(problemsOf({ a: '2026-09-13T09:30:00' }, (reader) => reader.time('a'))).toEqual(['payload.a: field.not_a_time']);
    expect(problemsOf({ a: '2026-13-45T09:30:00Z' }, (reader) => reader.time('a'))).toEqual(['payload.a: field.not_a_time']);
    expect(new FieldReader({}, '').optionalTime('a')).toBeUndefined();
    expect(problemsOf({ a: 'later' }, (reader) => reader.optionalTime('a'))).toEqual(['payload.a: field.not_a_time']);
  });

  it('reads a choice and names the allowed values when it is refused', () => {
    expect(new FieldReader({ a: 'queued' }, '').choice('a', ['queued', 'leased'])).toBe('queued');
    const reader = new FieldReader({ a: 'paused' }, 'payload');
    reader.choice('a', ['queued', 'leased']);
    expect(reader.problems).toEqual([
      { path: 'payload.a', code: FIELD_CODES.notAllowed, message: 'must be one of queued, leased' },
    ]);
    expect(problemsOf({}, (reader2) => reader2.choice('a', ['queued']))).toEqual(['payload.a: field.required']);
  });

  it('requires a value to be present without caring what it is', () => {
    expect(new FieldReader({ a: 0 }, '').present('a')).toBe(0);
    expect(problemsOf({}, (reader) => reader.present('a'))).toEqual(['payload.a: field.required']);
  });

  it('parses a nested payload and keeps its problems under the child path', () => {
    expect(new FieldReader({ a: { name: 'Ada', age: 1 } }, '').parsed('a', parsePerson, { name: '', age: 0 })).toEqual({
      name: 'Ada',
      age: 1,
    });
    expect(problemsOf({ a: { name: 'Ada' } }, (reader) => reader.parsed('a', parsePerson, { name: '', age: 0 }))).toEqual([
      'payload.a.age: field.required',
    ]);
    expect(problemsOf({}, (reader) => reader.parsed('a', parsePerson, { name: '', age: 0 }))).toEqual([
      'payload.a: field.required',
    ]);
    expect(new FieldReader({}, '').optionalParsed('a', parsePerson)).toBeUndefined();
    expect(new FieldReader({ a: { name: 'Grace', age: 2 } }, '').optionalParsed('a', parsePerson)).toEqual({
      name: 'Grace',
      age: 2,
    });
    expect(problemsOf({ a: 1 }, (reader) => reader.optionalParsed('a', parsePerson))).toEqual([
      'payload.a: field.not_an_object',
    ]);
  });

  it('parses a list of payloads and reports the index of each one that fails', () => {
    expect(new FieldReader({ a: [{ name: 'Ada', age: 1 }] }, '').parsedList('a', parsePerson)).toEqual([
      { name: 'Ada', age: 1 },
    ]);
    expect(problemsOf({ a: [{ name: 'Ada', age: 1 }, { age: 2 }] }, (reader) => reader.parsedList('a', parsePerson))).toEqual([
      'payload.a.1.name: field.required',
    ]);
    expect(problemsOf({ a: {} }, (reader) => reader.parsedList('a', parsePerson))).toEqual(['payload.a: field.not_a_list']);
    expect(problemsOf({}, (reader) => reader.parsedList('a', parsePerson))).toEqual(['payload.a: field.required']);
  });

  it('refuses a field the payload forbids, and stays quiet when it is absent', () => {
    const present = new FieldReader({ data: 1 }, 'payload');
    present.absent('data', 'envelope.mixed', 'must not be here');
    expect(present.problems).toEqual([
      { path: 'payload.data', code: 'envelope.mixed', message: 'must not be here' },
    ]);
    const missing = new FieldReader({}, 'payload');
    missing.absent('data', 'envelope.mixed', 'must not be here');
    expect(missing.problems).toEqual([]);
  });

  it('parses an optional list of payloads only when it is there', () => {
    expect(new FieldReader({}, '').optionalParsedList('a', parsePerson)).toBeUndefined();
    expect(new FieldReader({ a: [{ name: 'Ada', age: 1 }] }, '').optionalParsedList('a', parsePerson)).toEqual([
      { name: 'Ada', age: 1 },
    ]);
    expect(problemsOf({ a: [{ age: 1 }] }, (reader) => reader.optionalParsedList('a', parsePerson))).toEqual([
      'payload.a.0.name: field.required',
    ]);
  });

  it('takes a problem a payload rule found that no field type can express', () => {
    const reader = new FieldReader({}, 'payload');
    reader.reject('a', 'job.lease_missing', 'is leased with no expiry');
    expect(reader.problems).toEqual([
      { path: 'payload.a', code: 'job.lease_missing', message: 'is leased with no expiry' },
    ]);
  });
});
