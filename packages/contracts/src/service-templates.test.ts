import { describe, expect, it } from 'vitest';

import {
  instantiate,
  parseTemplateInstantiation,
  parseServiceTemplateBody,
  parseServiceTemplateDraft,
  parseServiceTemplateName,
  parseServiceTemplateStatus,
  templateFromService,
} from './service-templates.js';

import type { EntryFill, ServiceTemplateBody } from './service-templates.js';
import type { Service } from './services.js';

const VALID_BODY = {
  sections: [
    {
      id: 'welcome',
      name: 'Welcome',
      entries: [
        { id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide' },
        { id: 'song-1', slot: 'typed', itemKind: 'song', required: true },
        { id: 'reading-1', slot: 'typed', itemKind: 'reading', required: false },
      ],
    },
  ],
};

describe('parseTemplateInstantiation', () => {
  it('reads title, date, site and fills', () => {
    const body = { title: 'Sunday', date: '2026-09-27', site: 'Main', fills: [{ entryId: 'e1', title: 'Song', content: { id: 'g', revision: 2, hash: 'fnv1a-6fe1d1e9' } }] };
    expect(parseTemplateInstantiation(body)).toMatchObject({ ok: true, value: { title: 'Sunday', fills: [{ entryId: 'e1' }] } });
  });

  it('refuses a date that is not a calendar day', () => {
    expect(parseTemplateInstantiation({ title: 'S', date: '27.09.2026', site: 'M', fills: [] }).ok).toBe(false);
  });
});

describe('parseServiceTemplateBody', () => {
  it('reads fixed and typed-slot entries', () => {
    const parsed = parseServiceTemplateBody(VALID_BODY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the body to parse');
    expect(parsed.value.sections[0]?.entries).toHaveLength(3);
    expect(parsed.value.sections[0]?.entries[1]).toEqual({
      id: 'song-1',
      slot: 'typed',
      itemKind: 'song',
      required: true,
    });
  });

  it('rejects a fixed entry claiming a required flag', () => {
    const parsed = parseServiceTemplateBody({
      sections: [
        {
          id: 'welcome',
          name: 'Welcome',
          entries: [{ id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide', required: true }],
        },
      ],
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a typed entry claiming a title', () => {
    const parsed = parseServiceTemplateBody({
      sections: [
        {
          id: 'welcome',
          name: 'Welcome',
          entries: [{ id: 'song-1', slot: 'typed', itemKind: 'song', required: true, title: 'Not allowed' }],
        },
      ],
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a custom-slide fixed entry that pins content', () => {
    const parsed = parseServiceTemplateBody({
      sections: [
        {
          id: 'welcome',
          name: 'Welcome',
          entries: [
            {
              id: 'opener',
              slot: 'fixed',
              itemKind: 'custom-slide',
              title: 'Welcome slide',
              content: { id: 'x', revision: 1 },
            },
          ],
        },
      ],
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects a repeated entry id inside one Service Template', () => {
    const parsed = parseServiceTemplateBody({
      sections: [
        {
          id: 'welcome',
          name: 'Welcome',
          entries: [
            { id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide' },
            { id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide again' },
          ],
        },
      ],
    });
    expect(parsed.ok).toBe(false);
  });

  it('never carries box geometry: a smuggled frame is dropped, not merely ignored', () => {
    const parsed = parseServiceTemplateBody({
      sections: [
        {
          id: 'welcome',
          name: 'Welcome',
          entries: [
            {
              id: 'opener',
              slot: 'fixed',
              itemKind: 'custom-slide',
              title: 'Welcome slide',
              frame: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the body to parse');
    const entry = parsed.value.sections[0]?.entries[0];
    expect(entry).toBeDefined();
    expect('frame' in (entry as object)).toBe(false);
  });
});

describe('parseServiceTemplateDraft', () => {
  it('reads a name and sections into a name/body draft', () => {
    const parsed = parseServiceTemplateDraft({ name: 'Sunday Service', sections: VALID_BODY.sections });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('expected the draft to parse');
    expect(parsed.value.name).toBe('Sunday Service');
    expect(parsed.value.body.sections).toHaveLength(1);
  });
});

describe('parseServiceTemplateStatus', () => {
  it('reads whether a Service Template is being hidden or brought back, and refuses anything else', () => {
    expect(parseServiceTemplateStatus({ archived: true })).toEqual({ ok: true, value: { archived: true } });
    const parsed = parseServiceTemplateStatus({ archived: 'yes' });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((problem) => `${problem.path}: ${problem.code}`)).toEqual([
      'serviceTemplate.archived: field.not_a_boolean',
    ]);
  });
});

describe('parseServiceTemplateName', () => {
  it('reads just the name fromService asks a caller for', () => {
    expect(parseServiceTemplateName({ name: 'Sunday Service' })).toEqual({ ok: true, value: { name: 'Sunday Service' } });
    const parsed = parseServiceTemplateName({});
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.map((problem) => `${problem.path}: ${problem.code}`)).toEqual([
      'serviceTemplate.name: field.required',
    ]);
  });
});

const BODY: ServiceTemplateBody = {
  sections: [
    {
      id: 'welcome',
      name: 'Welcome',
      entries: [
        { id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide', content: undefined },
        { id: 'song-1', slot: 'typed', itemKind: 'song', required: true },
        { id: 'reading-1', slot: 'typed', itemKind: 'reading', required: false },
      ],
    },
  ],
};

const SONG_FILL: EntryFill = {
  entryId: 'song-1',
  title: 'Amazing Grace',
  content: { id: 'song-amazing-grace', revision: 3, hash: undefined },
};

describe('instantiate', () => {
  it('instantiates the fixed entry and a filled typed entry, leaving an unfilled optional slot out', () => {
    const outcome = instantiate(BODY, [SONG_FILL]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected instantiation to succeed');
    expect(outcome.items).toEqual([
      { id: 'opener', kind: 'custom-slide', title: 'Welcome slide', enabled: true, content: undefined },
      { id: 'song-1', kind: 'song', title: 'Amazing Grace', enabled: true, content: SONG_FILL.content },
    ]);
  });

  it('refuses instantiation when a required typed slot is unfilled, naming it', () => {
    const outcome = instantiate(BODY, []);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected instantiation to be refused');
    expect(outcome.errors).toEqual([
      { entryId: 'song-1', kind: 'unfilled-required-slot', message: 'song-1 is a required slot and was not filled' },
    ]);
  });

  it('collects every unfilled required slot, not only the first', () => {
    const twoRequired: ServiceTemplateBody = {
      sections: [
        {
          id: 's',
          name: 'S',
          entries: [
            { id: 'a', slot: 'typed', itemKind: 'song', required: true },
            { id: 'b', slot: 'typed', itemKind: 'reading', required: true },
          ],
        },
      ],
    };
    const outcome = instantiate(twoRequired, []);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected instantiation to be refused');
    expect(outcome.errors.map((error) => error.entryId)).toEqual(['a', 'b']);
  });

  const TYPED_CUSTOM_SLIDE: ServiceTemplateBody = {
    sections: [
      {
        id: 's',
        name: 'S',
        entries: [{ id: 'slide-1', slot: 'typed', itemKind: 'custom-slide', required: true }],
      },
    ],
  };

  it('refuses a fill that pins content onto a typed custom-slide slot', () => {
    const outcome = instantiate(TYPED_CUSTOM_SLIDE, [
      { entryId: 'slide-1', title: 'Not allowed', content: { id: 'song-x', revision: 1, hash: undefined } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected instantiation to be refused');
    expect(outcome.errors).toEqual([
      {
        entryId: 'slide-1',
        kind: 'content-not-allowed',
        message: 'slide-1 is a custom slide and must not be filled with pinned content',
      },
    ]);
  });

  it('refuses a fill that omits content for a reusable-content typed slot', () => {
    const reusableContent: ServiceTemplateBody = {
      sections: [
        {
          id: 's',
          name: 'S',
          entries: [{ id: 'song-2', slot: 'typed', itemKind: 'song', required: true }],
        },
      ],
    };
    const outcome = instantiate(reusableContent, [{ entryId: 'song-2', title: 'Untitled', content: undefined }]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected instantiation to be refused');
    expect(outcome.errors).toEqual([
      { entryId: 'song-2', kind: 'content-required', message: 'song-2 must be filled with pinned content' },
    ]);
  });

  it('instantiates a typed custom-slide slot filled without content, and the result round-trips through conversion', () => {
    const outcome = instantiate(TYPED_CUSTOM_SLIDE, [{ entryId: 'slide-1', title: 'Welcome', content: undefined }]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected instantiation to succeed');
    expect(outcome.items).toEqual([{ id: 'slide-1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined }]);

    const converted = templateFromService({
      id: 'service-x',
      title: 'X',
      date: '2026-09-20',
      site: 'main',
      state: 'upcoming',
      sections: [{ id: 's', name: 'S', items: outcome.items }],
    });
    const parsed = parseServiceTemplateBody(converted);
    expect(parsed.ok).toBe(true);
  });
});

const SERVICE: Service = {
  id: 'service-1',
  title: 'Sunday Service',
  date: '2026-09-20',
  site: 'main',
  state: 'upcoming',
  sections: [
    {
      id: 'welcome',
      name: 'Welcome',
      items: [
        { id: 'opener', kind: 'custom-slide', title: 'Welcome slide', enabled: true, content: undefined },
        {
          id: 'song-1',
          kind: 'song',
          title: 'Amazing Grace',
          enabled: true,
          content: { id: 'song-amazing-grace', revision: 3, hash: undefined },
        },
      ],
    },
  ],
};

describe('templateFromService', () => {
  it('keeps a custom slide fixed with its content, and turns any other item into a required typed slot', () => {
    const body = templateFromService(SERVICE);
    expect(body).toEqual({
      sections: [
        {
          id: 'welcome',
          name: 'Welcome',
          entries: [
            { id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide', content: undefined },
            { id: 'song-1', slot: 'typed', itemKind: 'song', required: true },
          ],
        },
      ],
    });
  });

  it('leaves the source service unchanged', () => {
    const before = structuredClone(SERVICE);
    templateFromService(SERVICE);
    expect(SERVICE).toEqual(before);
  });
});
