import { describe, expect, it } from 'vitest';

import { ContextError, contextProblems, correlationFor, requestContext, systemContext } from './context.js';

const FULL = { actor: 'account:7f3a', permissions: ['runEvents.append'], correlationId: 'req-0f9c2a41' };

describe('a request context', () => {
  it('carries the actor, the permissions and the correlation identifier, and cannot be edited after', () => {
    const context = requestContext(FULL);
    expect(context).toEqual(FULL);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.permissions)).toBe(true);
  });

  it('accepts an actor with no permissions at all, which is what a fresh account has', () => {
    expect(requestContext({ ...FULL, permissions: [] }).permissions).toEqual([]);
  });

  it('refuses an actor nobody named, because a durable record would carry the blank', () => {
    expect(() => requestContext({ ...FULL, actor: '  ' })).toThrow(ContextError);
    expect(() => requestContext({ ...FULL, actor: '  ' })).toThrow('actor: expected the account or process acting');
  });

  it('refuses a correlation identifier that cannot be followed through a log', () => {
    expect(() => requestContext({ ...FULL, correlationId: '' })).toThrow('correlationId: expected');
    expect(() => requestContext({ ...FULL, correlationId: 'req 1' })).toThrow('correlationId: expected');
    expect(() => requestContext({ ...FULL, correlationId: 'r'.repeat(65) })).toThrow('correlationId: expected');
  });

  it('refuses a permission list with a blank or a repeat in it', () => {
    expect(() => requestContext({ ...FULL, permissions: ['runEvents.append', ''] })).toThrow('permissions: expected');
    expect(() => requestContext({ ...FULL, permissions: ['a.read', 'a.read'] })).toThrow('permissions: names a.read twice');
  });

  it('reports every problem at once, the way the settings loader does', () => {
    expect(() => requestContext({ actor: '', permissions: [], correlationId: '' })).toThrow(/actor: .*; correlationId: /u);
  });
});

describe('grading a context that arrived as data', () => {
  it('reads a valid one as having nothing wrong with it', () => {
    expect(contextProblems(requestContext(FULL))).toEqual([]);
  });

  it('refuses anything that is not a context at all', () => {
    expect(contextProblems(undefined)).toEqual(['context: expected an actor, permissions and a correlation identifier']);
    expect(contextProblems('account:7f3a')).toEqual(['context: expected an actor, permissions and a correlation identifier']);
  });

  it('refuses a permission list that is not a list', () => {
    expect(contextProblems({ ...FULL, permissions: 'runEvents.append' })).toEqual(['permissions: expected a list of names']);
  });
});

describe('the context the schema work runs under', () => {
  it('acts as the process, not as a person, and carries only the schema permissions', () => {
    const context = systemContext('migrate-0f9c2a41');
    expect(context.actor).toBe('system');
    expect(context.permissions).toEqual(['schemaMigrations.append', 'schemaMigrations.read']);
    expect(context.correlationId).toBe('migrate-0f9c2a41');
  });
});

describe('a correlation identifier made out of one this server did not choose', () => {
  it('is one a context accepts, whatever the identifier it was made from held', () => {
    for (const id of ['req-1', 'a/b c', '', 'x'.repeat(200), '…']) {
      expect(contextProblems({ actor: 'system', permissions: [], correlationId: correlationFor('guard:', id) })).toEqual(
        [],
      );
    }
  });

  it('replaces what the alphabet leaves out rather than dropping it, which would fold two into one', () => {
    expect(correlationFor('claim:', 'a/b c')).toBe('claim:a-b-c');
    expect(correlationFor('claim:', 'a/b')).not.toBe(correlationFor('claim:', 'ab'));
  });

  it('never outgrows what a context accepts, however long the identifier was', () => {
    expect(correlationFor('guard:', 'x'.repeat(200))).toHaveLength(64);
  });
});
