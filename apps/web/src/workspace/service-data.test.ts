import { describe, expect, it } from 'vitest';

import { findItem, itemsOf, readServiceList, readServiceView } from './service-data.js';

const record = {
  stamp: { id: 'service-1', updatedAt: '2026-09-27T10:00:00.000Z' },
  title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming',
  sections: [
    { id: 'first', name: 'Welcome', items: [{ id: 'a', kind: 'custom-slide', title: 'A', enabled: true, content: undefined }] },
    { id: 'second', name: 'Message', items: [{ id: 'b', kind: 'custom-slide', title: 'B', enabled: true, content: undefined }] },
  ],
};

describe('service data', () => {
  it('reads a stamped service record and flattens its items in section order', () => {
    const view = readServiceView(record);
    expect(view).toMatchObject({ id: record.stamp.id, revision: record.stamp.updatedAt });
    expect(itemsOf(view!)).toMatchObject([{ sectionId: 'first', item: { id: 'a' }, index: 0 }, { sectionId: 'second', item: { id: 'b' }, index: 0 }]);
    expect(findItem(view!, 'b')).toMatchObject({ id: 'b' });
    expect(findItem(view!, 'absent')).toBeUndefined();
  });

  it('refuses malformed data and filters malformed list entries', () => {
    const malformed = { ...record, stamp: { id: record.stamp.id, updatedAt: 1 } };
    expect(readServiceView(malformed)).toBeUndefined();
    expect(readServiceView(null)).toBeUndefined();
    expect(readServiceList(malformed)).toBeUndefined();
    expect(readServiceList([record, malformed])).toMatchObject([{ id: record.stamp.id }]);
  });
});
