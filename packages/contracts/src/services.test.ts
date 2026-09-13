import { describe, expect, it } from 'vitest';

import { FIELD_CODES } from './problems.js';
import { ITEM_KINDS, SERVICE_STATES, SERVICE_STATE_LABELS, parseRevisionRef, parseService } from './services.js';

// A service in the vocabulary specification 4 settles, with the revision and hash shapes the phase
// fixtures record. The product repository holds no phase artifacts, so the values are written out here.
const service = () => ({
  id: 'service-1',
  title: 'Sunday Morning',
  date: '2026-09-13',
  site: 'Main Hall',
  state: 'upcoming',
  sections: [
    {
      id: 'section-1',
      name: 'Worship',
      items: [
        { id: 'item-1', kind: 'song', title: 'Amazing Grace', content: { id: 'song-4', revision: 'rev-5', hash: 'fnv1a-6fe1d1e9' } },
        { id: 'item-2', kind: 'custom-slide', title: 'Welcome' },
      ],
    },
    {
      id: 'section-2',
      name: 'Word',
      items: [{ id: 'item-3', kind: 'sermon', title: 'Grace', content: { id: 'sermon-2', revision: 'rev-9' } }],
    },
  ],
});

const codes = (value: unknown) => {
  const parsed = parseService(value);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.problems.map((problem) => `${problem.path}=${problem.code}`);
};

const defective = (change: (value: ReturnType<typeof service>) => void) => {
  const value = service();
  change(value);
  return codes(value);
};

describe('the vocabulary a service is written in', () => {
  it('names the four lifecycle states, each with the words the product calls it by', () => {
    expect(SERVICE_STATES).toEqual(['upcoming', 'presenting', 'completed', 'archived']);
    expect(SERVICE_STATES.map((state) => SERVICE_STATE_LABELS[state])).toEqual([
      'Upcoming',
      'Presenting',
      'Completed',
      'Archived',
    ]);
  });

  it('names every kind of entry a service order can carry', () => {
    expect(ITEM_KINDS).toEqual(['song', 'sermon', 'reading', 'media', 'slide-group', 'custom-slide']);
  });
});

describe('a reference to one immutable revision', () => {
  it('parses a reference with the hash the revision is addressed by, and one without', () => {
    const withHash = { id: 'song-4', revision: 'rev-5', hash: 'fnv1a-6fe1d1e9' };
    expect(parseRevisionRef(withHash, 'content')).toEqual({ ok: true, value: withHash });
    expect(parseRevisionRef({ id: 'song-4', revision: 'rev-5' }, 'content')).toEqual({
      ok: true,
      value: { id: 'song-4', revision: 'rev-5' },
    });
  });

  it('refuses a reference to content without saying which revision', () => {
    expect(parseRevisionRef({ id: 'song-4' }, 'content')).toEqual({
      ok: false,
      problems: [{ path: 'content.revision', code: FIELD_CODES.required, message: 'is required' }],
    });
  });

  it('refuses a hash that does not name the algorithm that produced it', () => {
    const parsed = parseRevisionRef({ id: 'song-4', revision: 'rev-5', hash: 'deadbeef' }, 'content');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.code)).toEqual([FIELD_CODES.notAllowed]);
  });
});

describe('reading one service', () => {
  it('parses a dated, sited service with its ordered sections and items', () => {
    expect(parseService(service())).toEqual({ ok: true, value: service() });
  });

  it('parses a section an editor has not filled in yet', () => {
    const empty = service();
    empty.sections[1]!.items = [];
    expect(parseService(empty)).toEqual({ ok: true, value: empty });
  });

  it('refuses a service that is not an object', () => {
    expect(parseService('service-1')).toEqual({
      ok: false,
      problems: [{ path: 'service', code: FIELD_CODES.notAnObject, message: 'must be an object' }],
    });
  });

  it('refuses a service with no title and no site, because a service is a dated, sited event', () => {
    expect(
      defective((value) => {
        value.title = '';
        delete (value as { site?: string }).site;
      }),
    ).toEqual([`service.title=${FIELD_CODES.empty}`, `service.site=${FIELD_CODES.required}`]);
  });

  it('refuses a date that is not a day anyone could hold a service on', () => {
    expect(defective((value) => (value.date = '2026-09-31'))).toEqual([`service.date=${FIELD_CODES.notAllowed}`]);
    expect(defective((value) => (value.date = '2026-13-01'))).toEqual([`service.date=${FIELD_CODES.notAllowed}`]);
    expect(defective((value) => (value.date = 'next Sunday'))).toEqual([`service.date=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses a lifecycle state the product never declared', () => {
    expect(defective((value) => (value.state = 'live'))).toEqual([`service.state=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses two sections claiming one identity', () => {
    expect(defective((value) => (value.sections[1]!.id = 'section-1'))).toEqual([
      `service.sections.1.id=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses the same item twice, even in two different sections', () => {
    expect(defective((value) => (value.sections[1]!.items[0]!.id = 'item-1'))).toEqual([
      `service.sections.1.items.0.id=${FIELD_CODES.notAllowed}`,
    ]);
  });

  it('refuses reusable content with no pinned revision, because a service pins what it shows', () => {
    expect(
      defective((value) => {
        delete (value.sections[0]!.items[0] as { content?: unknown }).content;
      }),
    ).toEqual([`service.sections.0.items.0.content=${FIELD_CODES.required}`]);
  });

  it('refuses a custom slide that pins reusable content it does not have', () => {
    expect(
      defective((value) => {
        (value.sections[0]!.items[1] as { content?: unknown }).content = { id: 'song-4', revision: 'rev-5' };
      }),
    ).toEqual([`service.sections.0.items.1.content=${FIELD_CODES.notAllowed}`]);
  });

  it('refuses an item of a kind no service order has', () => {
    expect(defective((value) => (value.sections[0]!.items[1]!.kind = 'announcement'))).toEqual([
      `service.sections.0.items.1.kind=${FIELD_CODES.notAllowed}`,
      `service.sections.0.items.1.content=${FIELD_CODES.required}`,
    ]);
  });

  it('refuses sections that are not a list of sections', () => {
    expect(defective((value) => ((value as { sections: unknown }).sections = {}))).toEqual([
      `service.sections=${FIELD_CODES.notAList}`,
    ]);
  });

  it('reports every defect in one service at once rather than the first', () => {
    expect(
      defective((value) => {
        value.state = 'live';
        value.sections[0]!.name = '';
        value.sections[1]!.items[0]!.title = '';
      }),
    ).toEqual([
      `service.state=${FIELD_CODES.notAllowed}`,
      `service.sections.0.name=${FIELD_CODES.empty}`,
      `service.sections.1.items.0.title=${FIELD_CODES.empty}`,
    ]);
  });
});
