import { describe, expect, it } from 'vitest';

import { parseSermonFile } from '@holydeck/core/sermon';
import { appendRevision, createEmptyStoreFile } from '@holydeck/core/storage';

import { libraryOn } from './library.js';
import { RECORDS } from './records.js';
import { revisionsOn } from './revisions.js';
import { SermonError, sermonContext, sermonsOn } from './sermons.js';
import { slideGroupsOn } from './slide-groups.js';
import { slideLayoutContext, slideLayoutsOn } from './slide-layouts.js';
import { fakeDb } from '../test/helpers/fake-db.js';

import type { BoxBinding, SlideLayoutBody, TextLayoutBox } from '@holydeck/contracts/layouts';
import type { SermonBody, SermonGeneration } from './sermons.js';

const ADMIN = sermonContext(`account:${'C'.repeat(22)}`, 'req-sermon');
const LAYOUT_ADMIN = slideLayoutContext(ADMIN.actor, ADMIN.correlationId);
const now = (): string => '2026-09-18T08:00:00.000Z';
const BODY: SermonBody = {
  sermon: parseSermonFile(`translations: [TAM, ROM]
verses:
  - {book: PSA, chapter: 117, verses: 2, offsets: {ROM: 1}}
  - {book: PSA, chapter: 117, verses: 1}
`),
  languages: {
    ta: { translation: 'TAM', title: 'நன்றி', speaker: 'பேச்சாளர்', points: ['இரக்கம்', 'துதி'] },
    'ta-Latn': { translation: 'ROM', title: 'Nandri', speaker: 'Speaker', points: ['Kindness', 'Praise'] },
  },
};

const box = (id: string, binding: BoxBinding): TextLayoutBox => ({
  id, kind: 'text', importance: 'required',
  frame: { x: 0, y: 0, width: 1, height: 1 }, binding,
  style: { fontFamily: 'Inter', fontWeight: 400, sizeRatio: 0.05, lineHeight: 1, align: 'start', verticalAlign: 'start' },
});
const keyed = (id: string, contentKind: 'sermon' | 'reading' | 'song', contentKey: string, languageKey = 'ta'): TextLayoutBox =>
  box(id, { mode: 'keyed', contentKind, contentKey, languageKey });
const LAYOUT: SlideLayoutBody = { boxes: [
  keyed('title', 'sermon', 'title'), keyed('point', 'sermon', 'point'),
  keyed('speaker', 'sermon', 'speaker'), keyed('scripture', 'sermon', 'scriptureRef'),
  keyed('text', 'reading', 'verseText'), keyed('reference', 'reading', 'reference'),
  keyed('translation', 'reading', 'translation'), keyed('romanized', 'reading', 'verseText', 'ta-Latn'),
  box('static', { mode: 'static', text: 'Sunday' }),
  { id: 'media', kind: 'media', importance: 'decoration', frame: { x: 0, y: 0, width: 1, height: 1 }, style: { fit: 'cover', opacity: 1 } },
] };

function stores() {
  const db = fakeDb();
  let serial = 0;
  const options = { now, newId: () => `content-${++serial}` };
  return {
    db, options, sermons: sermonsOn(db, options), library: libraryOn(db, options),
    revisions: revisionsOn(db, options), groups: slideGroupsOn(db, options),
    layouts: slideLayoutsOn(db, { now, newId: () => `layout-${++serial}` }),
  };
}

function bible(translation: string) {
  const file = createEmptyStoreFile(translation, now());
  file.books['PSA'] = { chapters: { '117': appendRevision(undefined, {
    '1': `${translation} praise`, '2': `${translation} kindness`, '3': `${translation} shifted`,
  }, 3, now()).record } };
  return file;
}

async function generation(layout = LAYOUT) {
  const store = stores();
  const source = await store.sermons.create(ADMIN, 'Sunday sermon', BODY);
  const selected = await store.layouts.create(LAYOUT_ADMIN, { name: 'Sermon', body: layout });
  const input: SermonGeneration = {
    sermonRevision: source.revision, slideLayoutId: selected.stamp.id, slideLayoutRevision: selected.revision,
    storeFiles: { TAM: bible('TAM'), ROM: bible('ROM') },
  };
  return { ...store, source, selected, input };
}

describe('sermon configurations', () => {
  it('registers a sermon and versions its SermonFile and language content through the revision store', async () => {
    const { sermons, library, revisions } = stores();
    const created = await sermons.create(ADMIN, 'Sunday sermon', BODY);
    const id = created.stamp.id;
    expect(created.stamp.kind).toBe('sermon');
    expect((await library.list(ADMIN, { kind: 'sermon' })).map((row) => row.stamp.id)).toEqual([id]);
    expect(await sermons.current(ADMIN, id)).toEqual(created);
    const changed = { ...BODY, sermon: { ...BODY.sermon, entries: [...BODY.sermon.entries].reverse() } };
    expect((await sermons.edit(ADMIN, id, changed))?.revision).toBe(2);
    expect((await sermons.edit(ADMIN, id, changed))?.revision).toBe(2);
    expect(await revisions.count(ADMIN, id)).toBe(2);
    expect(await sermons.current(ADMIN, id, 1)).toEqual(created);
    expect((await sermons.history(ADMIN, id)).map((row) => row.body)).toEqual([BODY, changed]);
    expect(await sermons.current(ADMIN, id, 99)).toBeUndefined();
  });

  it('answers missing items and refuses another content kind', async () => {
    const { sermons, library } = stores();
    expect(await sermons.current(ADMIN, 'missing')).toBeUndefined();
    expect(await sermons.edit(ADMIN, 'missing', BODY)).toBeUndefined();
    expect(await sermons.history(ADMIN, 'missing')).toEqual([]);
    const other = await library.create(ADMIN, { kind: 'song', title: 'Song' });
    await expect(sermons.current(ADMIN, other.stamp.id)).rejects.toMatchObject({ kind: 'state' });
    await expect(sermons.history(ADMIN, other.stamp.id)).rejects.toMatchObject({ kind: 'state' });
  });

  it.each([
    null,
    { ...BODY, sermon: { ...BODY.sermon, translations: [] } },
    { ...BODY, sermon: { ...BODY.sermon, entries: [{ book: 'bad', chapter: 1, verses: [1], offsets: {} }] } },
    { ...BODY, sermon: { ...BODY.sermon, entries: [{ book: 'PSA', chapter: 1, verses: ['1'], offsets: {} }] } },
    { ...BODY, sermon: { ...BODY.sermon, notices: [1] } },
    { ...BODY, languages: {} },
    { ...BODY, languages: { en: { translation: 'TAM', title: 'Title' } } },
    { ...BODY, languages: { ta: { translation: 'MISSING', title: 'Title' } } },
    { ...BODY, languages: { ta: { translation: 'TAM', title: '' } } },
    { ...BODY, languages: { ta: { translation: 'TAM', title: 'Title', points: ['one'] } } },
  ])('rejects invalid bodies before creating a library stamp (%#)', async (body) => {
    const { sermons, library } = stores();
    await expect(sermons.create(ADMIN, 'Invalid', body as SermonBody)).rejects.toBeInstanceOf(SermonError);
    expect(await library.list(ADMIN)).toEqual([]);
  });

  it('preserves parser notices, template and optional language metadata', async () => {
    const { sermons } = stores();
    const body = { sermon: { ...BODY.sermon, template: '{{ entries }}', notices: ['Legacy format'] }, languages: { ta: { title: 'Title', translation: 'TAM' } } };
    const created = await sermons.create(ADMIN, 'Minimal', body);
    expect((await sermons.current(ADMIN, created.stamp.id))?.body).toEqual(body);
  });

  it('detects missing and invalid stored bodies, even if the revision hash is valid', async () => {
    const { sermons, library, revisions } = stores();
    const row = await library.create(ADMIN, { kind: 'sermon', title: 'Incomplete' });
    await expect(sermons.current(ADMIN, row.stamp.id)).rejects.toMatchObject({ kind: 'corrupt' });
    await revisions.save(ADMIN, { contentId: row.stamp.id, body: { wrong: true }, origin: 'manual-checkpoint' });
    await expect(sermons.current(ADMIN, row.stamp.id)).rejects.toMatchObject({ kind: 'corrupt' });
    await expect(sermons.history(ADMIN, row.stamp.id)).rejects.toMatchObject({ kind: 'corrupt' });
  });

  it('keeps revision conflicts and permission checks from the composed stores', async () => {
    const { sermons, db } = stores();
    const created = await sermons.create(ADMIN, 'Sermon', BODY);
    db.failOn = (collection) => collection === RECORDS.contentRevisions.collection
      ? Object.assign(new Error('duplicate'), { code: 11000 }) : undefined;
    await expect(sermons.edit(ADMIN, created.stamp.id, { ...BODY, sermon: { ...BODY.sermon, notices: ['new'] } }))
      .rejects.toMatchObject({ kind: 'conflict' });
    await expect(sermons.current({ ...ADMIN, permissions: [] }, created.stamp.id)).rejects.toMatchObject({ kind: 'permission' });
  });
});

describe('sermon slide generation', () => {
  it('uses the selected source and Layout revisions, mixed bindings, entry order and translation offsets', async () => {
    const { sermons, layouts, groups, source, selected, input } = await generation();
    await layouts.version(LAYOUT_ADMIN, selected.stamp.id, { boxes: [keyed('new-title', 'sermon', 'title')] });
    await sermons.edit(ADMIN, source.stamp.id, { ...BODY, languages: { ta: { translation: 'TAM', title: 'Changed' } } });
    const group = await sermons.generate(ADMIN, source.stamp.id, input);
    expect(group.body.generatedFrom).toEqual({
      sermonId: source.stamp.id, sermonRevision: 1, slideLayoutId: selected.stamp.id, slideLayoutRevision: 1,
    });
    expect(group.body.mode).toBe('generated');
    expect(group.body.slides.map((slide) => slide.label)).toEqual(['PSA 117:2', 'PSA 117:1']);
    expect(group.body.slides[0]?.languageBlocks).toEqual([
      { id: 'title', languageKey: 'ta', text: 'நன்றி' }, { id: 'point', languageKey: 'ta', text: 'இரக்கம்' },
      { id: 'speaker', languageKey: 'ta', text: 'பேச்சாளர்' }, { id: 'scripture', languageKey: 'ta', text: 'Psalms 117:2' },
      { id: 'text', languageKey: 'ta', text: 'TAM kindness' }, { id: 'reference', languageKey: 'ta', text: 'Psalms 117:2' },
      { id: 'translation', languageKey: 'ta', text: 'TAM' }, { id: 'romanized', languageKey: 'ta-Latn', text: 'ROM shifted' },
    ]);
    expect(group.body.slides[1]?.languageBlocks.find((block) => block.id === 'romanized')?.text).toBe('ROM praise');
    expect((await groups.current(ADMIN, group.stamp.id))?.body.generatedFrom).toEqual(group.body.generatedFrom);
  });

  it('regenerates identical slides without appending a revision; changed inputs append once', async () => {
    const { sermons, source, input, revisions, groups } = await generation();
    const group = await sermons.generate(ADMIN, source.stamp.id, input);
    const repeated = await sermons.generate(ADMIN, source.stamp.id, { ...input, slideGroupId: group.stamp.id });
    expect(repeated.body).toEqual(group.body);
    expect(await revisions.count(ADMIN, group.stamp.id)).toBe(1);
    const changed = await sermons.edit(ADMIN, source.stamp.id, { ...BODY, languages: { ...BODY.languages, ta: { ...BODY.languages['ta']!, title: 'New title' } } });
    await sermons.generate(ADMIN, source.stamp.id, { ...input, sermonRevision: changed!.revision, slideGroupId: group.stamp.id });
    expect(await revisions.count(ADMIN, group.stamp.id)).toBe(2);
    expect((await groups.history(ADMIN, group.stamp.id))[0]?.body).toEqual(group.body);
  });

  it.each([undefined, 0, -1, 1.5, NaN])('requires explicit positive source and Layout revisions (%s)', async (revision) => {
    const { sermons, source, input, library } = await generation();
    for (const field of ['sermonRevision', 'slideLayoutRevision']) {
      await expect(sermons.generate(ADMIN, source.stamp.id, { ...input, [field]: revision } as SermonGeneration))
        .rejects.toMatchObject({ kind: 'schema' });
    }
    expect(await library.list(ADMIN, { kind: 'slideGroup' })).toEqual([]);
  });

  it.each(['source', 'source-revision', 'layout', 'layout-revision', 'group'])('refuses a missing %s without creating a group', async (missing) => {
    const { sermons, source, input, library } = await generation();
    await expect(sermons.generate(ADMIN, missing === 'source' ? 'missing' : source.stamp.id, {
      ...input,
      ...(missing === 'source-revision' ? { sermonRevision: 99 } : {}),
      ...(missing === 'layout' ? { slideLayoutId: 'missing' } : {}),
      ...(missing === 'layout-revision' ? { slideLayoutRevision: 99 } : {}),
      ...(missing === 'group' ? { slideGroupId: 'missing' } : {}),
    })).rejects.toMatchObject({ kind: 'state' });
    expect(await library.list(ADMIN, { kind: 'slideGroup' })).toEqual([]);
  });

  it.each([
    keyed('song', 'song', 'title'), keyed('missing-language', 'reading', 'verseText', 'en'),
  ])('refuses unresolvable keyed boxes ($id)', async (binding) => {
    const { sermons, source, input, library } = await generation({ boxes: [binding] });
    await expect(sermons.generate(ADMIN, source.stamp.id, input)).rejects.toMatchObject({ kind: 'state' });
    expect(await library.list(ADMIN, { kind: 'slideGroup' })).toEqual([]);
  });

  it('refuses missing bound metadata and missing Bible content before writing', async () => {
    const { sermons, source, input, library } = await generation();
    const minimal = await sermons.edit(ADMIN, source.stamp.id, { ...BODY, languages: { ta: { translation: 'TAM', title: 'Title' } } });
    await expect(sermons.generate(ADMIN, source.stamp.id, { ...input, sermonRevision: minimal!.revision })).rejects.toMatchObject({ kind: 'state' });
    await expect(sermons.generate(ADMIN, source.stamp.id, { ...input, storeFiles: {} })).rejects.toMatchObject({ code: 'chapter_not_in_store' });
    expect(await library.list(ADMIN, { kind: 'slideGroup' })).toEqual([]);
  });

  it('does not overwrite a custom group or another generator source', async () => {
    const { sermons, source, input, groups } = await generation();
    const generated = await sermons.generate(ADMIN, source.stamp.id, input);
    const custom = await groups.duplicate(ADMIN, generated.stamp.id);
    await expect(sermons.generate(ADMIN, source.stamp.id, { ...input, slideGroupId: custom!.stamp.id })).rejects.toMatchObject({ kind: 'state' });
    const other = await sermons.create(ADMIN, 'Other sermon', BODY);
    await expect(sermons.generate(ADMIN, other.stamp.id, { ...input, slideGroupId: generated.stamp.id })).rejects.toMatchObject({ kind: 'state' });
    expect((await groups.current(ADMIN, generated.stamp.id))?.body).toEqual(generated.body);
  });
});
