import { describe, expect, it } from 'vitest';

import {
  ENTITY_KINDS,
  ENTITY_POLICIES,
  ENTITY_STAMP_FIELDS,
  EntityError,
  archivedStamp,
  createdStamp,
  isEntityKind,
  parseEntityStamp,
  policyFor,
  PORTABLE_KINDS,
  purgeableAt,
  purgeRefusal,
  restoredStamp,
  touchedStamp,
} from './entities.js';
import { FIELD_CODES } from './problems.js';

const live = () => ({
  id: 'song-1',
  kind: 'song',
  schemaVersion: 1,
  createdAt: '2026-09-13T09:30:00Z',
  createdBy: 'editor-a',
  updatedAt: '2026-09-13T10:00:00Z',
  updatedBy: 'editor-b',
});

const archived = () => ({
  ...live(),
  id: 'media-1',
  kind: 'mediaAsset',
  archivedAt: '2026-09-13T11:00:00Z',
  archivedBy: 'admin-a',
});

const codes = (value: unknown) => {
  const parsed = parseEntityStamp(value);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

const without = (value: Record<string, unknown>, ...fields: readonly string[]): Record<string, unknown> => {
  const copy = { ...value };
  for (const field of fields) delete copy[field];
  return copy;
};

describe('what a durable entity is', () => {
  it('names every field the stamp carries, so a reader of one has the whole list', () => {
    expect(ENTITY_STAMP_FIELDS).toEqual([
      'id',
      'kind',
      'schemaVersion',
      'createdAt',
      'createdBy',
      'updatedAt',
      'updatedBy',
      'archivedAt',
      'archivedBy',
    ]);
  });

  it('names the kinds this build knows, in one sorted list with nothing repeated', () => {
    expect([...ENTITY_KINDS]).toEqual([...ENTITY_KINDS].toSorted());
    expect(new Set(ENTITY_KINDS).size).toBe(ENTITY_KINDS.length);
  });

  it('states what archiving and deleting mean for every kind, and names where that was decided', () => {
    for (const kind of ENTITY_KINDS) {
      const policy = ENTITY_POLICIES[kind];
      expect(policy.kind).toBe(kind);
      expect(policy.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(['hidden', 'disabled']).toContain(policy.archive);
      expect(['never', 'purge-after-grace']).toContain(policy.deletion);
      expect(policy.requirement).not.toBe('');
    }
  });

  it('carries a grace window exactly when something may eventually be deleted', () => {
    for (const kind of ENTITY_KINDS) {
      const policy = ENTITY_POLICIES[kind];
      expect(policy.graceDays === undefined).toBe(policy.deletion === 'never');
      if (policy.graceDays !== undefined) expect(policy.graceDays).toBeGreaterThan(0);
    }
  });

  it('refuses a kind nothing has decided anything about, rather than inventing a default', () => {
    expect(() => policyFor('podcast')).toThrow(EntityError);
    expect(() => policyFor('podcast')).toThrow('there is no durable entity kind named podcast');
  });

  it('resolves a declared kind by name, for the callers whose kind arrived as data', () => {
    expect(policyFor('mediaAsset').deletion).toBe('purge-after-grace');
    expect(policyFor('service').deletion).toBe('never');
    expect(policyFor('service').archive).toBe('disabled');
  });

  it('names which kinds travel, because only those have an export to be byte-stable about', () => {
    expect(PORTABLE_KINDS).toEqual(['song']);
    expect(PORTABLE_KINDS.every((kind) => ENTITY_POLICIES[kind].portable)).toBe(true);
  });

  it('knows a declared kind from anything else, for callers holding a string', () => {
    expect(isEntityKind('song')).toBe(true);
    expect(isEntityKind('podcast')).toBe(false);
  });
});

describe('when a purge becomes possible', () => {
  it('is the grace window after the entity was archived', () => {
    expect(purgeableAt(policyFor('mediaAsset'), '2026-09-13T11:00:00Z')).toBe('2027-03-12T11:00:00.000Z');
  });

  it('is never, for a kind nothing may delete', () => {
    expect(purgeableAt(policyFor('song'), '2026-09-13T11:00:00Z')).toBeUndefined();
  });
});

describe('reading one stored entity', () => {
  it('accepts a live entity and reports it as one', () => {
    const parsed = parseEntityStamp(live());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.archivedAt).toBeUndefined();
    expect(parsed.ok && parsed.value.updatedBy).toBe('editor-b');
  });

  it('accepts an archived entity, which is the only shape a purge can be asked about', () => {
    const parsed = parseEntityStamp(archived());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.archivedAt).toBe('2026-09-13T11:00:00Z');
    expect(parsed.ok && parsed.value.archivedBy).toBe('admin-a');
  });

  it('refuses something that is not an entity at all', () => {
    expect(codes('song-1')).toEqual(['entity=field.not_an_object']);
  });

  it('names every field it is missing at once, rather than one per attempt', () => {
    expect(codes(without(live(), 'id', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'schemaVersion'))).toEqual([
      `entity.id=${FIELD_CODES.required}`,
      `entity.schemaVersion=${FIELD_CODES.required}`,
      `entity.createdAt=${FIELD_CODES.required}`,
      `entity.createdBy=${FIELD_CODES.required}`,
      `entity.updatedAt=${FIELD_CODES.required}`,
      `entity.updatedBy=${FIELD_CODES.required}`,
    ]);
  });

  it('refuses a kind this build does not know, because nothing could say what to do with it', () => {
    expect(codes({ ...live(), kind: 'podcast' })).toEqual([`entity.kind=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses an authorship nobody is named in', () => {
    expect(codes({ ...live(), createdBy: '' })).toEqual([`entity.createdBy=${FIELD_CODES.empty}`]);
  });

  it('refuses a schema version this build is older than, rather than reading a document from the future', () => {
    const problems = codes({ ...live(), schemaVersion: 2 });
    expect(problems).toEqual([`entity.schemaVersion=${FIELD_CODES.notAllowed}`]);
  });

  it('accepts the version each kind is written at today', () => {
    for (const kind of ENTITY_KINDS) {
      const parsed = parseEntityStamp({ ...live(), kind, schemaVersion: ENTITY_POLICIES[kind].schemaVersion });
      expect(parsed.ok).toBe(true);
    }
  });

  it('refuses a version that is not a count of versions', () => {
    expect(codes({ ...live(), schemaVersion: 0 })).toEqual([`entity.schemaVersion=${FIELD_CODES.tooSmall}`]);
  });

  it('refuses an entity changed before it existed', () => {
    expect(codes({ ...live(), updatedAt: '2026-09-13T09:29:59Z' })).toEqual([`entity.updatedAt=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses an archival with nobody named in it, and a name with no archival', () => {
    expect(codes(without(archived(), 'archivedBy'))).toEqual([`entity.archivedBy=${FIELD_CODES.required}`]);
    expect(codes(without(archived(), 'archivedAt'))).toEqual([`entity.archivedAt=${FIELD_CODES.required}`]);
    expect(codes({ ...archived(), archivedBy: '' })).toEqual([`entity.archivedBy=${FIELD_CODES.empty}`]);
  });

  it('refuses an entity archived before it existed', () => {
    expect(codes({ ...archived(), archivedAt: '2026-09-13T09:29:59Z' })).toEqual([
      `entity.archivedAt=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses an instant a database could not compare as text', () => {
    expect(codes({ ...live(), createdAt: '13.09.2026' })).toEqual([`entity.createdAt=${FIELD_CODES.notATime}`]);
  });
});

describe('stamping one through its life', () => {
  const created = () => createdStamp({ id: 'media-1', kind: 'mediaAsset', at: '2026-09-13T09:30:00Z', by: 'admin-a' });

  const parses = (stamp: unknown) => parseEntityStamp(stamp).ok;

  it('creates one that is live, at the version this build writes, and that reads back as an entity', () => {
    expect(created()).toEqual({
      id: 'media-1',
      kind: 'mediaAsset',
      schemaVersion: 1,
      createdAt: '2026-09-13T09:30:00Z',
      createdBy: 'admin-a',
      updatedAt: '2026-09-13T09:30:00Z',
      updatedBy: 'admin-a',
      archivedAt: undefined,
      archivedBy: undefined,
    });
    expect(parses(created())).toBe(true);
  });

  it('records who changed it and when, and leaves who created it alone', () => {
    const touched = touchedStamp(created(), { at: '2026-09-13T10:00:00Z', by: 'admin-b' });
    expect(touched.updatedBy).toBe('admin-b');
    expect(touched.updatedAt).toBe('2026-09-13T10:00:00Z');
    expect(touched.createdBy).toBe('admin-a');
    expect(parses(touched)).toBe(true);
  });

  it('refuses to change an archived entity, because archiving is what stops it changing', () => {
    const archivedOne = archivedStamp(created(), { at: '2026-09-13T11:00:00Z', by: 'admin-b' });
    expect(() => touchedStamp(archivedOne, { at: '2026-09-13T12:00:00Z', by: 'admin-b' })).toThrow(
      'media-1 is archived',
    );
  });

  it('archives one, naming the moment and the person a grace period is counted from', () => {
    const archivedOne = archivedStamp(created(), { at: '2026-09-13T11:00:00Z', by: 'admin-b' });
    expect(archivedOne.archivedAt).toBe('2026-09-13T11:00:00Z');
    expect(archivedOne.archivedBy).toBe('admin-b');
    expect(archivedOne.updatedAt).toBe('2026-09-13T11:00:00Z');
    expect(parses(archivedOne)).toBe(true);
    expect(() => archivedStamp(archivedOne, { at: '2026-09-13T12:00:00Z', by: 'admin-b' })).toThrow(
      'media-1 is already archived',
    );
  });

  it('restores one, which is the answer to an archival somebody regrets', () => {
    const archivedOne = archivedStamp(created(), { at: '2026-09-13T11:00:00Z', by: 'admin-b' });
    const restored = restoredStamp(archivedOne, { at: '2026-09-13T12:00:00Z', by: 'admin-c' });
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.archivedBy).toBeUndefined();
    expect(restored.updatedBy).toBe('admin-c');
    expect(parses(restored)).toBe(true);
    expect(() => restoredStamp(restored, { at: '2026-09-13T13:00:00Z', by: 'admin-c' })).toThrow(
      'media-1 is not archived',
    );
  });
});

describe('deciding whether something may be purged', () => {
  const stamp = createdStamp({ id: 'media-1', kind: 'mediaAsset', at: '2026-09-13T09:30:00Z', by: 'admin-a' });
  const archivedOne = archivedStamp(stamp, { at: '2026-09-13T11:00:00Z', by: 'admin-b' });

  it('refuses while it is still in use, because only an archived thing is a candidate', () => {
    expect(purgeRefusal(stamp, '2027-09-13T11:00:00Z')).toBe('media-1 is not archived');
  });

  it('refuses while the grace period is still running', () => {
    expect(purgeRefusal(archivedOne, '2027-03-11T11:00:00Z')).toBe(
      'media-1 may not be purged before 2027-03-12T11:00:00.000Z',
    );
  });

  it('allows it once the grace period has passed, which is what is revalidated before a deletion', () => {
    expect(purgeRefusal(archivedOne, '2027-03-12T11:00:00Z')).toBeUndefined();
  });

  it('refuses forever for a kind nothing deletes, whatever its age', () => {
    const archivedSong = archivedStamp(
      createdStamp({ id: 'song-1', kind: 'song', at: '2026-09-13T09:30:00Z', by: 'editor-a' }),
      { at: '2026-09-13T11:00:00Z', by: 'editor-a' },
    );
    expect(purgeRefusal(archivedSong, '2099-01-01T00:00:00Z')).toBe('a song is never purged');
  });
});
