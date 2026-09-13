import { describe, expect, it } from 'vitest';

import { EntityError } from './entities.js';
import {
  exportText,
  importText,
  PORTABLE_FORMAT,
  PORTABLE_FORMAT_VERSION,
  portableDocument,
  portableSchema,
  readPortable,
} from './portable.js';
import { FIELD_CODES } from './problems.js';

const current = portableSchema('song', 1, []);

const migrated = portableSchema('song', 3, [
  { from: 1, to: 2, migrate: (body) => ({ ...body, languages: [body['language']], language: undefined }) },
  { from: 2, to: 3, migrate: (body) => ({ ...body, titles: { ta: body['title'] }, title: undefined }) },
]);

const song = () => ({ title: 'Andru', languages: ['ta', 'ta-Latn'] });

const document = () => portableDocument(current, song());

const codes = (text: string, schema = current) => {
  const parsed = importText(text, schema);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

const body = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;

describe('declaring what travels', () => {
  it('stamps the format a reader identifies the file by, and the version of the format itself', () => {
    expect(PORTABLE_FORMAT).toBe('holydeck.portable');
    expect(PORTABLE_FORMAT_VERSION).toBe(1);
    expect(document().format).toBe(PORTABLE_FORMAT);
    expect(document().formatVersion).toBe(PORTABLE_FORMAT_VERSION);
    expect(document().kind).toBe('song');
    expect(document().schemaVersion).toBe(1);
  });

  it('refuses a schema for a kind that does not travel, rather than exporting one that cannot be imported', () => {
    expect(() => portableSchema('service', 1, [])).toThrow(EntityError);
    expect(() => portableSchema('service', 1, [])).toThrow('service is not a portable kind');
  });

  it('refuses a schema whose steps do not arrive at the version it claims', () => {
    expect(() => portableSchema('song', 3, [{ from: 1, to: 2, migrate: (read) => read }])).toThrow(
      'the last step of song reaches version 2, not 3',
    );
  });

  it('refuses a schema with a hole in it, because the version inside it has no step to leave by', () => {
    expect(() =>
      portableSchema('song', 3, [
        { from: 1, to: 2, migrate: (read) => read },
        { from: 2, to: 4, migrate: (read) => read },
      ]),
    ).toThrow('the steps of song do not run one version at a time');
  });

  it('refuses steps that are not in order, because reading them in order is what applies them', () => {
    expect(() =>
      portableSchema('song', 3, [
        { from: 2, to: 3, migrate: (read) => read },
        { from: 1, to: 2, migrate: (read) => read },
      ]),
    ).toThrow('the steps of song do not run one version at a time');
  });

  it('refuses a schema at no version at all, which no document could declare', () => {
    expect(() => portableSchema('song', 0, [])).toThrow('song cannot be at schema version 0');
  });

  it('accepts a kind at its first version, which has nothing to migrate from', () => {
    expect(current.kind).toBe('song');
    expect(current.schemaVersion).toBe(1);
    expect(current.oldest).toBe(1);
    expect(migrated.oldest).toBe(1);
  });
});

describe('writing one out', () => {
  it('writes the system-managed declaration first, so a reader knows what it holds before it reads it', () => {
    expect(exportText(document()).startsWith('{\n  "format": "holydeck.portable",\n  "formatVersion": 1,')).toBe(true);
  });

  it('writes the same bytes however the body was built, because a diff of an unchanged export is empty', () => {
    const reordered = portableDocument(current, { languages: ['ta', 'ta-Latn'], title: 'Andru' });
    expect(exportText(reordered)).toBe(exportText(document()));
  });

  it('sorts every nested object, because stability that stops at the top level is not stability', () => {
    const one = portableDocument(current, { sections: [{ label: 'verse-1', text: 'a' }] });
    const other = portableDocument(current, { sections: [{ text: 'a', label: 'verse-1' }] });
    expect(exportText(one)).toBe(exportText(other));
    expect(exportText(one)).toContain('"label": "verse-1"');
  });

  it('ends with a newline, because the export is a file somebody keeps in a repository', () => {
    expect(exportText(document()).endsWith('}\n')).toBe(true);
  });
});

describe('reading one back', () => {
  it('round-trips, and writing what was read reproduces the bytes exactly', () => {
    const text = exportText(document());
    const parsed = importText(text, current);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.body).toEqual(song());
    expect(parsed.ok && exportText(parsed.value)).toBe(text);
  });

  it('reads a document that arrived already parsed, such as one uploaded as JSON', () => {
    const parsed = readPortable(body(exportText(document())), current);
    expect(parsed.ok).toBe(true);
  });

  it('refuses text that is not a document at all', () => {
    expect(codes('title: Andru')).toEqual([`document=${FIELD_CODES.notAnObject}`]);
  });

  it('refuses a document that is a list of songs rather than one song', () => {
    expect(codes('[]')).toEqual([`document=${FIELD_CODES.notAnObject}`]);
  });

  it('refuses a file that never claimed to be one of ours', () => {
    expect(codes(JSON.stringify({ ...document(), format: 'songbook' }))).toEqual([
      `document.format=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('names everything the declaration is missing at once', () => {
    expect(codes('{}')).toEqual([
      `document.format=${FIELD_CODES.required}`,
      `document.formatVersion=${FIELD_CODES.required}`,
      `document.kind=${FIELD_CODES.required}`,
      `document.schemaVersion=${FIELD_CODES.required}`,
      `document.body=${FIELD_CODES.required}`,
    ]);
  });

  it('refuses a format version a newer HolyDeck wrote, rather than guessing what it added', () => {
    expect(codes(JSON.stringify({ ...document(), formatVersion: 2 }))).toEqual([
      `document.formatVersion=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a document of another kind, which is the mistake a shared folder makes easy', () => {
    expect(codes(JSON.stringify({ ...document(), kind: 'slideLayout' }))).toEqual([
      `document.kind=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a kind nothing exports at all, which no schema is ever opened for', () => {
    expect(codes(JSON.stringify({ ...document(), kind: 'service' }))).toEqual([
      `document.kind=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a body that is not an object, because a schema has nothing to read otherwise', () => {
    expect(codes(JSON.stringify({ ...document(), body: 'Andru' }))).toEqual([
      `document.body=${FIELD_CODES.notAnObject}`,
    ]);
  });

  it('refuses a schema version this build is older than, which is DATA-01 refusing a partial write', () => {
    expect(codes(JSON.stringify({ ...document(), schemaVersion: 2 }))).toEqual([
      `document.schemaVersion=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses a version older than any migration declares, rather than reading it as if it were current', () => {
    const ancient = JSON.stringify({ ...portableDocument(migrated, song()), schemaVersion: 1 });
    expect(codes(ancient, portableSchema('song', 3, [{ from: 2, to: 3, migrate: (read) => read }]))).toEqual([
      `document.schemaVersion=${FIELD_CODES.notAllowed}`,
    ]);
  });
});

describe('reading an older export', () => {
  const old = JSON.stringify({
    format: PORTABLE_FORMAT,
    formatVersion: PORTABLE_FORMAT_VERSION,
    kind: 'song',
    schemaVersion: 1,
    body: { title: 'Andru', language: 'ta' },
  });

  it('migrates it one declared version at a time, and reports it at the version this build writes', () => {
    const parsed = importText(old, migrated);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.schemaVersion).toBe(3);
    expect(parsed.ok && parsed.value.body).toEqual({ languages: ['ta'], titles: { ta: 'Andru' } });
  });

  it('leaves the document it was given untouched, because a refused import must change nothing', () => {
    const source = body(old);
    Object.freeze(source);
    Object.freeze(source['body']);
    const parsed = readPortable(source, migrated);
    expect(parsed.ok).toBe(true);
    expect(source['body']).toEqual({ title: 'Andru', language: 'ta' });
  });

  it('writes the migrated document as bytes that read back unchanged', () => {
    const first = importText(old, migrated);
    const text = first.ok ? exportText(first.value) : '';
    const second = importText(text, migrated);
    expect(second.ok).toBe(true);
    expect(second.ok && exportText(second.value)).toBe(text);
  });
});
