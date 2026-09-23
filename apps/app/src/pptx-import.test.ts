import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { HolyDeckError } from '@holydeck/core/messages';

import { libraryContext, libraryOn } from './library.js';
import { pptxImportContext, pptxImportOn } from './pptx-import.js';
import { fakeDb } from '../test/helpers/fake-db.js';
import { fakeMediaPurgeDb } from '../test/helpers/media-purge-db.js';
import { fakeMediaStorageIO } from '../test/helpers/media-storage-io.js';

import type { LibraryStore } from './library.js';
import type { PptxImport } from './pptx-import.js';
import type { Queue } from './queue.js';
import type { FakeDb } from '../test/helpers/fake-db.js';
import type { FakeMediaStorageIO } from '../test/helpers/media-storage-io.js';

// Minimal OOXML fixture builders, adapted from `packages/core/src/pptx.test.ts` (not shared/exported
// across packages, since that file's helpers are test-only) — just enough surface to prove text-block
// pass-through and T54 media registration wire up correctly. `extractPptx` itself is already exhaustively
// covered in `packages/core`; these fixtures don't re-prove its own parsing rules.
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const MEDIA_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

function textShapeXml(text: string, id: number): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

/** A `<p:sp>` title-placeholder shape, for provenance-fallback tests — see `packages/core/src/pptx.ts`'s
 *  `extractTitlePlaceholder`. */
function titlePlaceholderXml(text: string, id: number): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Title ${id}"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

/** OOXML's `docProps/core.xml` core-properties part, for provenance tests — see `packages/core/src/pptx.ts`'s
 *  `extractProvenance`. */
function corePropsXml(fields: { title?: string; creator?: string }): Uint8Array {
  const title = fields.title === undefined ? '' : `<dc:title>${fields.title}</dc:title>`;
  const creator = fields.creator === undefined ? '' : `<dc:creator>${fields.creator}</dc:creator>`;
  return strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      `xmlns:dc="http://purl.org/dc/elements/1.1/">${title}${creator}</cp:coreProperties>`,
  );
}

function blipShapeXml(id: number, relId: string): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch/></p:blipFill><p:spPr/></p:pic>`
  );
}

function slideXml(shapesXml: string): Uint8Array {
  return strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<p:sld xmlns:p="${P_NS}" xmlns:a="${A_NS}"><p:cSld><p:spTree>` +
      `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
      `${shapesXml}</p:spTree></p:cSld></p:sld>`,
  );
}

function presentationXml(relIds: string[]): Uint8Array {
  const sldIdLst = relIds.map((relId, index) => `<p:sldId id="${256 + index}" r:id="${relId}"/>`).join('');
  return strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}">` +
      `<p:sldIdLst>${sldIdLst}</p:sldIdLst></p:presentation>`,
  );
}

function relsXml(type: string, entries: [relId: string, target: string][]): Uint8Array {
  const rels = entries.map(([id, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('');
  return strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}">${rels}</Relationships>`);
}

/** Builds a `.pptx` archive from one shapes-XML fragment per slide, plus arbitrary extra archive entries
 *  (a slide's own `_rels` part, its referenced media bytes) for the media-registration tests below. */
function buildPptx(slides: string[], extraFiles: Record<string, Uint8Array> = {}): Uint8Array {
  const relIds = slides.map((_, index) => `rId${index + 1}`);
  const files: Record<string, Uint8Array> = {
    'ppt/presentation.xml': presentationXml(relIds),
    'ppt/_rels/presentation.xml.rels': relsXml(
      SLIDE_REL_TYPE,
      relIds.map((relId, index): [string, string] => [relId, `slides/slide${index + 1}.xml`]),
    ),
    ...extraFiles,
  };
  slides.forEach((shapesXml, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = slideXml(shapesXml);
  });
  return zipSync(files);
}

/** A minimal valid PNG signature plus a filler byte — enough for magic-byte sniffing, not a decodable
 *  image, per the task's "tiny synthetic images you construct yourself" constraint. */
const pngBytes = (): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/** Bytes that match no v1 media signature — a stand-in for an embedded chart/SmartArt/OLE object. */
const unknownBytes = (): Uint8Array => new Uint8Array([0x01, 0x02, 0x03, 0x04]);

const ADMIN = pptxImportContext(`account:${'D'.repeat(22)}`, 'req-pptx');
// A separate, fuller-permission context, only for seeding a library row a test wants an import to
// collide with — pptxImportContext's own permissions stay narrow, per its own doc comment.
const LIBRARIAN = libraryContext(`account:${'D'.repeat(22)}`, 'req-library-seed');

const setup = (): { db: FakeDb; io: FakeMediaStorageIO; importer: PptxImport; catalogue: LibraryStore } => {
  const db = fakeDb();
  const io = fakeMediaStorageIO();
  let tick = 0;
  let serial = 0;
  const jobs: Array<Parameters<Queue['enqueue']>[1]> = [];
  const now = () => new Date(Date.parse('2026-09-17T09:30:00.000Z') + (tick += 1) * 1000).toISOString();
  const newId = () => `media-${(serial += 1)}`;
  const importer = pptxImportOn(db, {
    now,
    newId,
    mediaRoot: () => '/media',
    write: io.write,
    read: io.read,
    remove: io.remove,
    purge: fakeMediaPurgeDb(db),
    queue: {
      async enqueue(_context, input) {
        jobs.push(input);
        return { id: `job-${jobs.length}`, created: true };
      },
    },
  });
  // The same store `pptxImportOn` composes internally, so tests can seed a song to collide with.
  const catalogue = libraryOn(db, { now, newId });
  return { db, io, importer, catalogue };
};

describe('pptxImportOn', () => {
  it('passes each slide\'s text blocks through unchanged, with no media registered', async () => {
    const { io, importer } = setup();
    const bytes = buildPptx([textShapeXml('Amazing Grace', 2), textShapeXml('How sweet the sound', 2)]);

    const result = await importer.import(ADMIN, bytes);

    expect(result.slides.map((slide) => slide.textBlocks)).toEqual([['Amazing Grace'], ['How sweet the sound']]);
    expect(result.slides.every((slide) => slide.media.length === 0)).toBe(true);
    expect(result.skippedMedia).toEqual([]);
    expect(io.writes).toEqual([]);
  });

  it('registers a slide\'s embedded media through the T54 media manifest', async () => {
    const { io, importer } = setup();
    const bytes = buildPptx([blipShapeXml(2, 'rId1')], {
      'ppt/slides/_rels/slide1.xml.rels': relsXml(MEDIA_REL_TYPE, [['rId1', '../media/image1.png']]),
      'ppt/media/image1.png': pngBytes(),
    });

    const result = await importer.import(ADMIN, bytes);

    expect(result.slides).toHaveLength(1);
    expect(result.slides[0]?.textBlocks).toEqual([]);
    expect(result.slides[0]?.media).toHaveLength(1);
    expect(result.slides[0]?.media[0]?.manifest).toMatchObject({ type: 'image/png', bytes: 10 });
    expect(io.writes).toHaveLength(1);
  });

  it('reuses the existing record when the same media is embedded on more than one slide', async () => {
    const { io, importer } = setup();
    const bytes = buildPptx([blipShapeXml(2, 'rId1'), blipShapeXml(2, 'rId1')], {
      'ppt/slides/_rels/slide1.xml.rels': relsXml(MEDIA_REL_TYPE, [['rId1', '../media/image1.png']]),
      'ppt/slides/_rels/slide2.xml.rels': relsXml(MEDIA_REL_TYPE, [['rId1', '../media/image1.png']]),
      'ppt/media/image1.png': pngBytes(),
    });

    const result = await importer.import(ADMIN, bytes);

    expect(result.slides[0]?.media).toHaveLength(1);
    expect(result.slides[1]?.media).toHaveLength(1);
    expect(result.slides[1]?.media[0]).toEqual(result.slides[0]?.media[0]);
    // One upload only: the second reference reuses the standing record by content hash.
    expect(io.writes).toHaveLength(1);
  });

  it('passes skipped media through untouched, without registering it', async () => {
    const { io, importer } = setup();
    const bytes = buildPptx([blipShapeXml(2, 'rId1')], {
      'ppt/slides/_rels/slide1.xml.rels': relsXml(MEDIA_REL_TYPE, [['rId1', '../media/unknown.bin']]),
      'ppt/media/unknown.bin': unknownBytes(),
    });

    const result = await importer.import(ADMIN, bytes);

    expect(result.slides[0]?.media).toEqual([]);
    expect(result.skippedMedia).toEqual([{ slideIndex: 0, relationshipId: 'rId1', target: 'ppt/media/unknown.bin' }]);
    expect(io.writes).toEqual([]);
  });

  it('propagates the underlying HolyDeckError for a structurally broken .pptx, writing nothing', async () => {
    const { db, io, importer } = setup();
    const bytes = strToU8('this is plain text, not a zip archive of any kind');

    await expect(importer.import(ADMIN, bytes)).rejects.toBeInstanceOf(HolyDeckError);
    expect(io.writes).toEqual([]);
    expect(db.rows.size).toBe(0);
  });

  it('passes the extracted title/source provenance through unchanged', async () => {
    const { importer } = setup();
    const bytes = buildPptx([textShapeXml('Amazing Grace', 2)], {
      'docProps/core.xml': corePropsXml({ title: 'Amazing Grace', creator: 'Traditional' }),
    });

    const result = await importer.import(ADMIN, bytes);

    expect(result.provenance).toEqual({ title: 'Amazing Grace', source: 'Traditional' });
  });

  it('leaves provenance empty when the package declares no discoverable title or source', async () => {
    const { importer } = setup();
    const bytes = buildPptx([textShapeXml('How sweet the sound', 2)]);

    const result = await importer.import(ADMIN, bytes);

    expect(result.provenance).toEqual({});
  });

  it('warns of a possible duplicate when an existing song title normalizes the same as the discovered title', async () => {
    const { importer, catalogue } = setup();
    const existing = await catalogue.create(LIBRARIAN, { kind: 'song', title: 'Amazing Grace' });
    const bytes = buildPptx([titlePlaceholderXml('  amazing   GRACE  ', 2)]);

    const result = await importer.import(ADMIN, bytes);

    expect(result.duplicate).toEqual({ id: existing.stamp.id, title: 'Amazing Grace' });
    // The warning is data, never a refusal: the import itself still succeeds with its slides intact.
    expect(result.slides).toHaveLength(1);
  });

  it('does not warn when no existing song title matches the discovered title', async () => {
    const { importer, catalogue } = setup();
    await catalogue.create(LIBRARIAN, { kind: 'song', title: 'How Great Thou Art' });
    const bytes = buildPptx([titlePlaceholderXml('Amazing Grace', 2)]);

    const result = await importer.import(ADMIN, bytes);

    expect(result.duplicate).toBeUndefined();
  });

  it('does not warn when no title was discovered at all, even with a same-shaped song on file', async () => {
    const { importer, catalogue } = setup();
    await catalogue.create(LIBRARIAN, { kind: 'song', title: 'Amazing Grace' });
    const bytes = buildPptx([textShapeXml('no title placeholder here', 2)]);

    const result = await importer.import(ADMIN, bytes);

    expect(result.provenance.title).toBeUndefined();
    expect(result.duplicate).toBeUndefined();
  });

  it('does not warn against a non-song library item sharing the same title', async () => {
    const { importer, catalogue } = setup();
    await catalogue.create(LIBRARIAN, { kind: 'reading', title: 'Amazing Grace' });
    const bytes = buildPptx([titlePlaceholderXml('Amazing Grace', 2)]);

    const result = await importer.import(ADMIN, bytes);

    expect(result.duplicate).toBeUndefined();
  });
});
