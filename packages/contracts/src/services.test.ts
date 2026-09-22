import { describe, expect, it } from 'vitest';

import { FIELD_CODES } from './problems.js';
import {
  ITEM_KINDS,
  SERVICE_STATES,
  SERVICE_STATE_LABELS,
  isCanonicalTransition,
  joinAllowedFor,
  parseRevisionRef,
  parseService,
  parseServiceDraft,
  parseServiceItem,
  parseServiceItemReorder,
  parseServiceItemRevision,
  parseServiceSchedule,
  parseServiceStatus,
  parseServiceTransition,
} from './services.js';

import type { ServiceState } from './services.js';

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
        { id: 'item-1', kind: 'song', title: 'Amazing Grace', enabled: true, content: { id: 'song-4', revision: 5, hash: 'fnv1a-6fe1d1e9' } },
        { id: 'item-2', kind: 'custom-slide', title: 'Welcome', enabled: true },
      ],
    },
    {
      id: 'section-2',
      name: 'Word',
      items: [{ id: 'item-3', kind: 'sermon', title: 'Grace', enabled: true, content: { id: 'sermon-2', revision: 9 } }],
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

describe('reading a standalone service item', () => {
  it('reads a pinned item and starts fresh for each call', () => {
    const item = service().sections[0]!.items[0]!;
    expect(parseServiceItem(item)).toEqual({ ok: true, value: item });
    expect(parseServiceItem(item)).toEqual({ ok: true, value: item });
  });

  it('reads a custom slide with the default enabled flag', () => {
    const item = { id: 'item-2', kind: 'custom-slide', title: 'Welcome' };
    expect(parseServiceItem(item)).toEqual({
      ok: true, value: { ...item, enabled: true, content: undefined },
    });
  });

  it('rejects a missing title at the standalone item path', () => {
    expect(parseServiceItem({ id: 'item-2', kind: 'custom-slide' })).toEqual({
      ok: false,
      problems: [{ path: 'item.title', code: FIELD_CODES.required, message: 'is required' }],
    });
  });
});

describe('reading service action bodies', () => {
  it.each(['2026-09-13', 'next Sunday'])('reads schedule text: %s', (date) => {
    expect(parseServiceSchedule({ date })).toEqual({ ok: true, value: { date } });
  });

  it.each(SERVICE_STATES)('reads the transition state %s', (state) => {
    expect(parseServiceTransition({ state })).toEqual({ ok: true, value: { state } });
  });

  it.each([true, false])('reads archived as %s', (archived) => {
    expect(parseServiceStatus({ archived })).toEqual({ ok: true, value: { archived } });
  });

  it.each([['item-2', 'item-1'], []])('reads ordered item IDs: %j', (...itemIds) => {
    expect(parseServiceItemReorder({ itemIds })).toEqual({ ok: true, value: { itemIds } });
  });

  it.each([0, 5])('reads revision %s', (revision) => {
    expect(parseServiceItemRevision({ revision })).toEqual({ ok: true, value: { revision } });
  });

  it.each([
    { parse: parseServiceSchedule, body: {}, path: 'service.date', code: FIELD_CODES.required },
    { parse: parseServiceTransition, body: { state: 'live' }, path: 'service.state', code: FIELD_CODES.notAllowed },
    { parse: parseServiceStatus, body: { archived: 'true' }, path: 'service.archived', code: FIELD_CODES.notABoolean },
    { parse: parseServiceItemReorder, body: { itemIds: 'item-1' }, path: 'service.itemIds', code: FIELD_CODES.notAList },
    { parse: parseServiceItemReorder, body: { itemIds: ['item-1', 2] }, path: 'service.itemIds.1', code: FIELD_CODES.notText },
    { parse: parseServiceItemRevision, body: { revision: 1.5 }, path: 'service.revision', code: FIELD_CODES.notAWholeNumber },
    { parse: parseServiceItemRevision, body: { revision: -1 }, path: 'service.revision', code: FIELD_CODES.tooSmall },
  ])('rejects $body at $path with $code', ({ parse, body, path, code }) => {
    const parsed = parse(body);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.problems.map((problem) => ({ path: problem.path, code: problem.code })))
      .toEqual([{ path, code }]);
  });
});

describe('reading a service draft', () => {
  it('reads the title, date, site, and ordered sections without requiring an id or state', () => {
    const { title, date, site, sections } = service();
    const draft = { title, date, site, sections };
    expect(parseServiceDraft(draft)).toEqual({ ok: true, value: draft });
  });

  it('rejects an impossible date with the same problem as a full service', () => {
    const invalid = { ...service(), date: '2026-09-31' };
    expect(parseServiceDraft(invalid)).toEqual(parseService(invalid));
    expect(parseServiceDraft(invalid).ok).toBe(false);
  });

  it('never reads or carries an id or state supplied with a draft', () => {
    const { title, date, site, sections } = service();
    const parsed = parseServiceDraft({
      title, date, site, sections,
      get id() { throw new Error('a draft has no id'); },
      get state() { throw new Error('a draft has no state'); },
    });
    expect(parsed).toEqual({ ok: true, value: { title, date, site, sections } });
    if (!parsed.ok) throw new Error('the draft was refused');
    expect(parsed.value).not.toHaveProperty('id');
    expect(parsed.value).not.toHaveProperty('state');
  });
});

describe('an item’s enabled flag', () => {
  it('defaults true when the wire omits it, and round-trips false when set', () => {
    const omitted = service();
    delete (omitted.sections[0]!.items[0] as { enabled?: boolean }).enabled;
    const parsed = parseService(omitted);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the service to parse');
    expect(parsed.value.sections[0]!.items[0]!.enabled).toBe(true);

    const disabled = service();
    disabled.sections[0]!.items[0]!.enabled = false;
    const reparsed = parseService(disabled);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw new Error('expected the service to parse');
    expect(reparsed.value.sections[0]!.items[0]!.enabled).toBe(false);
  });

  it('refuses a value that merely looks like a flag', () => {
    expect(defective((value) => ((value.sections[0]!.items[0] as { enabled: unknown }).enabled = 'true'))).toEqual([
      `service.sections.0.items.0.enabled=${FIELD_CODES.notABoolean}`,
    ]);
  });
});

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

  it('never carries the superseded draft / presenting / ended / locked naming spec 8.1 replaced', () => {
    expect(SERVICE_STATES).toEqual(['upcoming', 'presenting', 'completed', 'archived']);
    expect(SERVICE_STATES).not.toContain('draft');
    expect(SERVICE_STATES).not.toContain('ended');
    expect(SERVICE_STATES).not.toContain('locked');
  });

  it('names every kind of entry a service order can carry', () => {
    expect(ITEM_KINDS).toEqual(['song', 'sermon', 'reading', 'media', 'slide-group', 'custom-slide']);
  });
});

describe('the canonical lifecycle steps ADR 0002 allows', () => {
  const table: readonly [ServiceState, ServiceState, boolean][] = [
    ['upcoming', 'presenting', true],
    ['presenting', 'completed', true],
    ['completed', 'archived', true],
    ['completed', 'presenting', false],
    ['upcoming', 'completed', false],
    ['archived', 'upcoming', false],
  ];

  it.each(table)('%s to %s is %s, per ADR 0002', (from, to, allowed) => {
    expect(isCanonicalTransition(from, to)).toBe(allowed);
  });
});

describe('joinAllowedFor', () => {
  it('allows joining only while a service is presenting', () => {
    expect(joinAllowedFor('presenting')).toBe(true);
    for (const state of SERVICE_STATES.filter((candidate) => candidate !== 'presenting')) {
      expect(joinAllowedFor(state)).toBe(false);
    }
  });
});

describe('a reference to one immutable revision', () => {
  it('parses a reference with the hash the revision is addressed by, and one without', () => {
    const withHash = { id: 'song-4', revision: 5, hash: 'fnv1a-6fe1d1e9' };
    expect(parseRevisionRef(withHash, 'content')).toEqual({ ok: true, value: withHash });
    expect(parseRevisionRef({ id: 'song-4', revision: 5 }, 'content')).toEqual({
      ok: true,
      value: { id: 'song-4', revision: 5 },
    });
  });

  it.each(['1', 'rev-5', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a revision that is not a positive integer: %s',
    (revision) => {
      const parsed = parseRevisionRef({ id: 'song-4', revision }, 'content');
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? [] : parsed.problems.map((problem) => problem.path)).toEqual(['content.revision']);
    },
  );

  it('refuses a reference to content without saying which revision', () => {
    expect(parseRevisionRef({ id: 'song-4' }, 'content')).toEqual({
      ok: false,
      problems: [{ path: 'content.revision', code: FIELD_CODES.required, message: 'is required' }],
    });
  });

  it('refuses a hash that does not name the algorithm that produced it', () => {
    const parsed = parseRevisionRef({ id: 'song-4', revision: 5, hash: 'deadbeef' }, 'content');
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
        (value.sections[0]!.items[1] as { content?: unknown }).content = { id: 'song-4', revision: 5 };
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
