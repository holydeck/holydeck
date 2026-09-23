import { describe, expect, it } from 'vitest';

import { nextService } from './next-service.js';

import type { ServiceView } from './service-data.js';

const view = (id: string, title: string, date: string, state: ServiceView['state'] = 'upcoming'): ServiceView => ({
  id, title, date, site: 'Main Hall', state, sections: [], revision: '2026-09-23T10:00:00.000Z',
});

describe('the next service', () => {
  it('picks the earliest upcoming service on or after today', () => {
    const list = [view('s1', 'Sunday', '2099-01-04'), view('s0', 'Last week', '2000-01-02')];

    expect(nextService(list, '2026-09-23')).toMatchObject({ id: 's1' });
  });

  it('excludes completed and archived services even when their date is still ahead', () => {
    const list = [view('s1', 'Completed', '2099-01-01', 'completed'), view('s2', 'Archived', '2099-01-02', 'archived')];

    expect(nextService(list, '2026-09-23')).toBeUndefined();
  });

  it('excludes a service dated before today', () => {
    expect(nextService([view('s1', 'Yesterday', '2026-09-22')], '2026-09-23')).toBeUndefined();
  });

  it('includes a service dated exactly today', () => {
    expect(nextService([view('s1', 'Today', '2026-09-23')], '2026-09-23')).toMatchObject({ id: 's1' });
  });

  it('breaks a same-date tie by title', () => {
    const list = [view('s1', 'Zion', '2099-01-01'), view('s2', 'Ascension', '2099-01-01')];

    expect(nextService(list, '2026-09-23')).toMatchObject({ id: 's2' });
  });

  it('keeps the earlier title when the later one in the list sorts after it', () => {
    const list = [view('s1', 'Ascension', '2099-01-01'), view('s2', 'Zion', '2099-01-01')];

    expect(nextService(list, '2026-09-23')).toMatchObject({ id: 's1' });
  });

  it('prefers a later-listed service whose date comes first', () => {
    const list = [view('s1', 'A', '2099-01-05'), view('s2', 'B', '2099-01-02')];

    expect(nextService(list, '2026-09-23')).toMatchObject({ id: 's2' });
  });

  it('keeps the earlier-listed service when a later-dated one follows', () => {
    const list = [view('s1', 'A', '2099-01-02'), view('s2', 'B', '2099-01-05')];

    expect(nextService(list, '2026-09-23')).toMatchObject({ id: 's1' });
  });

  it('answers nothing for an empty list', () => {
    expect(nextService([], '2026-09-23')).toBeUndefined();
  });
});
