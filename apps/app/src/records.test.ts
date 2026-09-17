import { describe, expect, it } from 'vitest';

import {
  DISCRIMINATOR_NAMES,
  RECORDS,
  RECORD_NAMES,
  RecordError,
  discriminatorIn,
  permissionsFor,
  recordFor,
} from './records.js';

const CLASSES = RECORD_NAMES.map((name) => [name, RECORDS[name]] as const);

describe('the durable record classes', () => {
  it('are the ones the milestone invariants name, each with a collection of its own', () => {
    expect([...RECORD_NAMES]).toEqual([
      'auditEvents',
      'contentRevisions',
      'preparedSnapshots',
      'runEvents',
      'schemaMigrations',
      'serviceTemplates',
      'services',
      'slideLayouts',
    ]);
    const collections = CLASSES.map(([, record]) => record.collection);
    expect(new Set(collections).size).toBe(collections.length);
  });

  it('are append-only or immutable, because v1 rewrites no durable record', () => {
    for (const [name, record] of CLASSES) {
      expect(['append-only', 'immutable'], name).toContain(record.kind);
    }
  });

  it('carry no tenant discriminator, which is what keeps a tenancy model additive', () => {
    for (const [name, record] of CLASSES) {
      expect(discriminatorIn(Object.keys(record.fields)), name).toBeUndefined();
    }
  });

  it('record who wrote each one and under which correlation identifier', () => {
    for (const [name, record] of CLASSES) {
      expect(record.fields['actor'], name).toBe('required');
      expect(record.fields['correlationId'], name).toBe('required');
    }
  });

  it('declare at least one field beyond the two the context supplies', () => {
    for (const [name, record] of CLASSES) {
      const own = Object.keys(record.fields).filter((field) => field !== 'actor' && field !== 'correlationId');
      expect(own.length, name).toBeGreaterThan(0);
      expect(Object.values(record.fields), name).toContain('required');
    }
  });
});

describe('the discriminator check', () => {
  it('catches the names a tenancy model would add, however they are written', () => {
    expect(discriminatorIn(['contentId', 'tenantId'])).toBe('tenantId');
    expect(discriminatorIn(['church_id'])).toBe('church_id');
    expect(discriminatorIn(['ORGANIZATIONID'])).toBe('ORGANIZATIONID');
    expect(discriminatorIn(['primaryChurchId'])).toBe('primaryChurchId');
    expect(discriminatorIn(['isTenanted'])).toBe('isTenanted');
    expect(discriminatorIn(['congregationId'])).toBe('congregationId');
    expect(discriminatorIn(['workspaceId'])).toBe('workspaceId');
  });

  it('leaves the identifiers a single-tenant product legitimately keeps', () => {
    expect(discriminatorIn(['contentId', 'serviceId', 'accountId', 'origin', 'runId'])).toBeUndefined();
  });

  it('names every form it refuses, so the repository-wide census can grade the same list', () => {
    expect([...DISCRIMINATOR_NAMES]).toEqual([...DISCRIMINATOR_NAMES].sort());
    expect(DISCRIMINATOR_NAMES).toContain('tenantId');
    expect(DISCRIMINATOR_NAMES).toContain('churchId');
    for (const name of DISCRIMINATOR_NAMES) expect(discriminatorIn([name]), name).toBe(name);
  });
});

describe('looking a record class up', () => {
  it('answers with the class when the name is one the product ships', () => {
    expect(recordFor('runEvents').collection).toBe(RECORDS.runEvents.collection);
  });

  it('refuses a name that arrived as data rather than guessing at a collection', () => {
    expect(() => recordFor('unknown')).toThrow(RecordError);
    expect(() => recordFor('unknown')).toThrow('there is no durable record class named unknown');
  });
});

describe('the permissions a record class needs', () => {
  it('are named after the class, so nothing has to be invented per collection', () => {
    expect(permissionsFor('auditEvents')).toEqual({ read: 'auditEvents.read', append: 'auditEvents.append' });
  });
});
