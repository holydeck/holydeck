import { describe, expect, it } from 'vitest';

import { SermonError, sermonContext, sermonsOn } from './sermons.js';
import { fakeDb } from '../test/helpers/fake-db.js';

describe('sermon permission errors', () => {
  it('exposes repository permission refusals as SermonError', async () => {
    const sermons = sermonsOn(fakeDb(), { now: () => '2026-09-18T08:00:00.000Z' });
    const context = { ...sermonContext(`account:${'C'.repeat(22)}`, 'req-sermon'), permissions: [] };
    const result = sermons.current(context, 'missing');
    await expect(result).rejects.toBeInstanceOf(SermonError);
    await expect(result).rejects.toMatchObject({ kind: 'permission' });
  });
});
