import { describe, expect, it } from 'vitest';

import { settled, staleRevision } from './refusals.js';

class FakeError extends Error {
  readonly kind: 'schema' | 'conflict' | 'corrupt';

  constructor(kind: 'schema' | 'conflict' | 'corrupt', message: string) {
    super(message);
    this.name = 'FakeError';
    this.kind = kind;
  }
}

const isRefusal = (error: unknown): error is FakeError & { kind: 'schema' | 'conflict' } =>
  error instanceof FakeError && error.kind !== 'corrupt';

describe('settled', () => {
  it('answers ok with the work’s own value when nothing was refused', async () => {
    await expect(settled(() => Promise.resolve('ok'), isRefusal)).resolves.toEqual({ ok: true, value: 'ok' });
  });

  it('turns a recognized refusal into ok:false, carrying its kind and message', async () => {
    const refusal = settled(() => Promise.reject(new FakeError('conflict', 'competing write')), isRefusal);
    await expect(refusal).resolves.toEqual({ ok: false, kind: 'conflict', message: 'competing write' });
  });

  it('rethrows an error the guard does not recognize as a refusal', async () => {
    await expect(settled(() => Promise.reject(new FakeError('corrupt', 'broken row')), isRefusal)).rejects.toThrow(
      'broken row',
    );
  });

  it('rethrows an error of an unrelated type outright', async () => {
    await expect(settled(() => Promise.reject(new Error('boom')), isRefusal)).rejects.toThrow('boom');
  });
});

describe('staleRevision', () => {
  it('answers undefined when the claimed revision still matches', () => {
    expect(staleRevision('song-1', 3, 3)).toBeUndefined();
  });

  it('names the revision actually on file when it has moved on', () => {
    expect(staleRevision('song-1', 3, 5)).toBe('song-1 is now at revision 5, not 3');
  });
});
