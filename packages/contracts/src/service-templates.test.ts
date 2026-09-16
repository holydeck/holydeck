import { describe, expect, it } from 'vitest';

import {
  instantiate,
  parseServiceTemplateBody,
  parseServiceTemplateDraft,
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
              content: { id: 'x', revision: '1' },
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
  content: { id: 'song-amazing-grace', revision: '3', hash: undefined },
};

describe('instantiate', () => {
  it('instantiates the fixed entry and a filled typed entry, leaving an unfilled optional slot out', () => {
    const outcome = instantiate(BODY, [SONG_FILL]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected instantiation to succeed');
    expect(outcome.items).toEqual([
      { id: 'opener', kind: 'custom-slide', title: 'Welcome slide', content: undefined },
      { id: 'song-1', kind: 'song', title: 'Amazing Grace', content: SONG_FILL.content },
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
        { id: 'opener', kind: 'custom-slide', title: 'Welcome slide', content: undefined },
        {
          id: 'song-1',
          kind: 'song',
          title: 'Amazing Grace',
          content: { id: 'song-amazing-grace', revision: '3', hash: undefined },
        },
      ],
    },
  ],
};

describe('templateFromService', () => {
  it('converts each item into a fixed entry with a matching id', () => {
    const body = templateFromService(SERVICE);
    expect(body).toEqual({
      sections: [
        {
          id: 'welcome',
          name: 'Welcome',
          entries: [
            { id: 'opener', slot: 'fixed', itemKind: 'custom-slide', title: 'Welcome slide', content: undefined },
            {
              id: 'song-1',
              slot: 'fixed',
              itemKind: 'song',
              title: 'Amazing Grace',
              content: { id: 'song-amazing-grace', revision: '3', hash: undefined },
            },
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
