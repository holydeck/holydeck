import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { HolyDeckError } from './messages.js';
import { extractPptx } from './pptx.js';
import type { ExtractedPptx } from './pptx.js';

// `extractPptx` must never reach the filesystem, success or failure alike — the same boundary
// `sermon-ai.test.ts` proves for the sermon pipeline. Every write path is replaced by a recorder that
// also refuses, so a stray write fails the test loudly instead of silently landing on disk.
const { fsWrites } = vi.hoisted(() => ({ fsWrites: [] as string[] }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const refuse = (name: string) => () => {
    fsWrites.push(name);
    throw new Error(`pptx extraction must not write to the filesystem (called ${name})`);
  };
  return {
    ...actual,
    appendFile: refuse('appendFile'),
    mkdir: refuse('mkdir'),
    open: refuse('open'),
    rename: refuse('rename'),
    rm: refuse('rm'),
    writeFile: refuse('writeFile'),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const refuse = (name: string) => () => {
    fsWrites.push(name);
    throw new Error(`pptx extraction must not write to the filesystem (called ${name})`);
  };
  return {
    ...actual,
    appendFileSync: refuse('appendFileSync'),
    createWriteStream: refuse('createWriteStream'),
    mkdirSync: refuse('mkdirSync'),
    openSync: refuse('openSync'),
    renameSync: refuse('renameSync'),
    rmSync: refuse('rmSync'),
    writeFileSync: refuse('writeFileSync'),
  };
});

const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

function escapeXml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** A `<p:sp>` text box: one `<a:p>` per paragraph, one `<a:r><a:t>` per run within it. */
function shapeXml(paragraphs: string[][], id: number): string {
  const body = paragraphs
    .map((runs) => `<a:p>${runs.map((t) => `<a:r><a:t>${escapeXml(t)}</a:t></a:r>`).join('')}</a:p>`)
    .join('');
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/>${body}</p:txBody></p:sp>`
  );
}

/** A `<p:grpSp>` wrapping other shapes, to prove nested shapes are still found. */
function groupXml(innerXml: string, id: number): string {
  return (
    `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr/>${innerXml}</p:grpSp>`
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
  const sldIdLst = relIds
    .map((relId, index) => `<p:sldId id="${256 + index}" r:id="${relId}"/>`)
    .join('');
  return strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<p:presentation xmlns:p="${P_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}">` +
      `<p:sldIdLst>${sldIdLst}</p:sldIdLst></p:presentation>`,
  );
}

function relsXml(entries: [relId: string, target: string][]): Uint8Array {
  const rels = entries
    .map(([id, target]) => `<Relationship Id="${id}" Type="${SLIDE_REL_TYPE}" Target="${target}"/>`)
    .join('');
  return strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<Relationships xmlns="${RELS_NS}">${rels}</Relationships>`,
  );
}

const MEDIA_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/** A slide's own `_rels` part, listing its embedded-media relationships. */
function mediaRelsXml(entries: [relId: string, target: string][]): Uint8Array {
  const rels = entries
    .map(([id, target]) => `<Relationship Id="${id}" Type="${MEDIA_REL_TYPE}" Target="${target}"/>`)
    .join('');
  return strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<Relationships xmlns="${RELS_NS}">${rels}</Relationships>`,
  );
}

/** A `<p:pic>` picture shape referencing embedded media through `<a:blip r:embed>` — the standard OOXML
 *  picture-fill reference, and the one embed mechanism T69 supports. */
function blipShapeXml(id: number, relId: string): string {
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${relId}"/><a:stretch/></p:blipFill><p:spPr/></p:pic>`
  );
}

/** A `<p:sp>` title-placeholder shape: same text-body shape as `shapeXml`, but its `<p:nvPr>` carries a
 *  `<p:ph type="…">` naming which OOXML placeholder kind it is — `"title"`, `"ctrTitle"`, or omitted for
 *  an ordinary body placeholder. */
function titlePlaceholderXml(paragraphs: string[][], id: number, phType?: string): string {
  const body = paragraphs
    .map((runs) => `<a:p>${runs.map((t) => `<a:r><a:t>${escapeXml(t)}</a:t></a:r>`).join('')}</a:p>`)
    .join('');
  const ph = phType === undefined ? '<p:ph/>' : `<p:ph type="${phType}"/>`;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Title ${id}"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/>${body}</p:txBody></p:sp>`
  );
}

/** OOXML's `docProps/core.xml` core-properties part, carrying only the two Dublin Core fields
 *  `extractProvenance` reads. Either field left `undefined` is simply omitted from the part, the same as
 *  a real file that never set it. */
function corePropsXml(fields: { title?: string; creator?: string }): Uint8Array {
  const title = fields.title === undefined ? '' : `<dc:title>${escapeXml(fields.title)}</dc:title>`;
  const creator = fields.creator === undefined ? '' : `<dc:creator>${escapeXml(fields.creator)}</dc:creator>`;
  return strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      `xmlns:dc="http://purl.org/dc/elements/1.1/">${title}${creator}</cp:coreProperties>`,
  );
}

/** A minimal valid 1x1 PNG's signature bytes plus a filler byte — enough for magic-byte sniffing, not a
 *  decodable image, per the task's "tiny synthetic images you construct yourself" constraint. */
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
}

/** Bytes that match none of the v1 media signatures — a stand-in for an embedded chart/SmartArt/OLE
 *  object `sniffMediaType` cannot type. */
function unknownBytes(): Uint8Array {
  return new Uint8Array([0x01, 0x02, 0x03, 0x04]);
}

/** One minimal signature-only fixture per v1 media type `sniffPptxMediaType` recognizes, to exercise
 *  every branch (including the GIF87a/GIF89a alternation and the WEBP RIFF+WEBP pair) through the public
 *  `extractPptx` entry point rather than reaching into the unexported sniffer directly. */
const SIGNATURE_FIXTURES: [type: string, bytes: Uint8Array][] = [
  ['image/png', pngBytes()],
  ['image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0x00])],
  ['image/gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])],
  ['image/gif', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])],
  ['image/webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])],
  ['video/mp4', new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x66, 0x74, 0x79, 0x70])],
  ['font/woff2', new Uint8Array([0x77, 0x4f, 0x46, 0x32])],
  ['font/ttf', new Uint8Array([0x00, 0x01, 0x00, 0x00])],
  ['font/otf', new Uint8Array([0x4f, 0x54, 0x54, 0x4f])],
];

/** Builds a `.pptx` archive like `buildPptx`, but also wires in arbitrary extra archive entries (a
 *  slide's `_rels` part, its referenced media bytes) for the embedded-media tests below. */
function buildPptxWithSlideFiles(slides: string[], extraFiles: Record<string, Uint8Array>): Uint8Array {
  const relIds = slides.map((_, index) => `rId${index + 1}`);
  const files: Record<string, Uint8Array> = {
    'ppt/presentation.xml': presentationXml(relIds),
    'ppt/_rels/presentation.xml.rels': relsXml(
      relIds.map((relId, index): [string, string] => [relId, `slides/slide${index + 1}.xml`]),
    ),
    ...extraFiles,
  };
  slides.forEach((shapesXml, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = slideXml(shapesXml);
  });
  return zipSync(files);
}

/** Builds a `.pptx` archive from one shapes-XML fragment per slide, wiring presentation.xml and its
 * relationships part to list them in the given order. */
function buildPptx(slides: string[]): Uint8Array {
  const relIds = slides.map((_, index) => `rId${index + 1}`);
  const files: Record<string, Uint8Array> = {
    'ppt/presentation.xml': presentationXml(relIds),
    'ppt/_rels/presentation.xml.rels': relsXml(
      relIds.map((relId, index): [string, string] => [relId, `slides/slide${index + 1}.xml`]),
    ),
  };
  slides.forEach((shapesXml, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = slideXml(shapesXml);
  });
  return zipSync(files);
}

// Eight slides, one or two text blocks each — the scale the controller ruled representative of a real
// PowerPoint song. Slide 3 proves runs concatenate with no separator and that a textless shape is
// dropped; slide 5 proves a shape nested inside a `<p:grpSp>` group is still found, in document order.
const VALID_SLIDES = [
  shapeXml([['Slide 1 Block 1 Line 1']], 2),
  shapeXml([['Slide 2 Block 1 Line 1']], 2) + shapeXml([['Slide 2 Block 2 Line 1'], ['Slide 2 Block 2 Line 2']], 3),
  shapeXml([['Slide 3 ', 'Block 1 Line 1']], 2) + shapeXml([], 3),
  shapeXml([['Slide 4 Block 1 Line 1']], 2) + shapeXml([['Slide 4 Block 2 Line 1']], 3),
  shapeXml([['Slide 5 Block 1 Line 1']], 2) + groupXml(shapeXml([['Slide 5 Block 2 Line 1']], 4), 3),
  shapeXml([['A & B']], 2),
  shapeXml([['Slide 7 Block 1 Line 1']], 2) + shapeXml([['Slide 7 Block 2 Line 1']], 3),
  shapeXml([['Slide 8 Block 1 Line 1']], 2),
];

const EXPECTED_BLOCKS = [
  ['Slide 1 Block 1 Line 1'],
  ['Slide 2 Block 1 Line 1', 'Slide 2 Block 2 Line 1\nSlide 2 Block 2 Line 2'],
  ['Slide 3 Block 1 Line 1'],
  ['Slide 4 Block 1 Line 1', 'Slide 4 Block 2 Line 1'],
  ['Slide 5 Block 1 Line 1', 'Slide 5 Block 2 Line 1'],
  ['A & B'],
  ['Slide 7 Block 1 Line 1', 'Slide 7 Block 2 Line 1'],
  ['Slide 8 Block 1 Line 1'],
];

describe('extractPptx on a valid presentation', () => {
  const bytes = buildPptx(VALID_SLIDES);

  it('extracts every slide in order with its text blocks exactly as authored', () => {
    const result = extractPptx(bytes);
    expect(result.slides.map((slide) => slide.textBlocks)).toEqual(EXPECTED_BLOCKS);
  });

  it('has no embedded media when no slide carries its own _rels part', () => {
    const result = extractPptx(bytes);
    expect(result.slides.every((slide) => slide.media.length === 0)).toBe(true);
    expect(result.skippedMedia).toEqual([]);
  });

  it('extracts the same file identically on repeat runs', () => {
    const first = extractPptx(bytes);
    const second = extractPptx(bytes);
    expect(second).toEqual(first);
  });

  it('completes within the 2000ms budget for a representative file', () => {
    // Generous on purpose: an order of magnitude above measured local runtime (single-digit
    // milliseconds for 8 slides / 13 blocks), tight enough to still catch an accidentally quadratic
    // parse, loose enough not to flake in CI.
    const started = performance.now();
    const result = extractPptx(bytes);
    const elapsed = performance.now() - started;
    expect(result.slides).toHaveLength(8);
    expect(elapsed).toBeLessThan(2000);
  });

  it('never touches the filesystem', () => {
    extractPptx(bytes);
    expect(fsWrites).toEqual([]);
  });
});

function codeOf(bytes: Uint8Array): string {
  try {
    extractPptx(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(HolyDeckError);
    return (error as HolyDeckError).code;
  }
  throw new Error('expected extractPptx to throw');
}

describe('extractPptx rejections', () => {

  it('rejects bytes that are not a ZIP archive at all', () => {
    const bytes = strToU8('this is plain text, not a zip archive of any kind');
    expect(codeOf(bytes)).toBe('pptx_corrupt');
  });

  it('rejects a valid ZIP that is missing ppt/slides/ structure entirely', () => {
    // A slide the relationships part promises but the archive never actually contains.
    const bytes = zipSync({
      'ppt/presentation.xml': presentationXml(['rId1']),
      'ppt/_rels/presentation.xml.rels': relsXml([['rId1', 'slides/slide1.xml']]),
    });
    expect(codeOf(bytes)).toBe('pptx_corrupt');
  });

  it('rejects a presentation part with no relationships part to resolve slide order', () => {
    const bytes = zipSync({ 'ppt/presentation.xml': presentationXml(['rId1']) });
    expect(codeOf(bytes)).toBe('pptx_corrupt');
  });

  it('rejects a slide relationship id the relationships part does not know', () => {
    const bytes = zipSync({
      'ppt/presentation.xml': presentationXml(['rId1']),
      'ppt/_rels/presentation.xml.rels': relsXml([['rId9', 'slides/slide1.xml']]),
      'ppt/slides/slide1.xml': slideXml(shapeXml([['unreachable']], 2)),
    });
    expect(codeOf(bytes)).toBe('pptx_corrupt');
  });

  it('rejects a valid ZIP that is not an OOXML presentation package', () => {
    const bytes = zipSync({ 'hello.txt': strToU8('just a plain zip file, not a presentation') });
    expect(codeOf(bytes)).toBe('pptx_unsupported');
  });

  it('rejects a presentation with no slides listed', () => {
    const bytes = buildPptx([]);
    expect(codeOf(bytes)).toBe('pptx_empty');
  });

  it('stores nothing on rejection: no partial result, no filesystem write', () => {
    let result: ExtractedPptx | undefined;
    try {
      result = extractPptx(strToU8('not a zip'));
    } catch {
      // expected
    }
    expect(result).toBeUndefined();
    expect(fsWrites).toEqual([]);
  });
});

describe('extractPptx embedded media', () => {
  it('extracts and types media a slide references through its own _rels part', () => {
    const bytes = buildPptxWithSlideFiles([blipShapeXml(2, 'rId1')], {
      'ppt/slides/_rels/slide1.xml.rels': mediaRelsXml([['rId1', '../media/image1.png']]),
      'ppt/media/image1.png': pngBytes(),
    });
    const result = extractPptx(bytes);
    expect(result.slides).toHaveLength(1);
    expect(result.slides[0]?.textBlocks).toEqual([]);
    expect(result.slides[0]?.media).toEqual([{ bytes: pngBytes(), type: 'image/png' }]);
    expect(result.skippedMedia).toEqual([]);
  });

  it('has no embedded media for a slide with a picture but no _rels part at all, not an error', () => {
    // Disclosed judgment call: T69 ruling 5 reads "no _rels part -> no embedded media" as unconditional,
    // so this is not treated as corrupt even though the slide XML references an r:embed id.
    const bytes = buildPptxWithSlideFiles([blipShapeXml(2, 'rId1')], {});
    const result = extractPptx(bytes);
    expect(result.slides[0]?.media).toEqual([]);
    expect(result.skippedMedia).toEqual([]);
  });

  it('skips a media part whose bytes sniff as no supported v1 type, without failing the extraction', () => {
    const bytes = buildPptxWithSlideFiles([blipShapeXml(2, 'rId1')], {
      'ppt/slides/_rels/slide1.xml.rels': mediaRelsXml([['rId1', '../media/unknown.bin']]),
      'ppt/media/unknown.bin': unknownBytes(),
    });
    const result = extractPptx(bytes);
    expect(result.slides[0]?.media).toEqual([]);
    expect(result.skippedMedia).toEqual([{ slideIndex: 0, relationshipId: 'rId1', target: 'ppt/media/unknown.bin' }]);
  });

  it('rejects an embed relationship id the slide\'s own _rels part does not know', () => {
    const bytes = buildPptxWithSlideFiles([blipShapeXml(2, 'rId9')], {
      'ppt/slides/_rels/slide1.xml.rels': mediaRelsXml([['rId1', '../media/image1.png']]),
      'ppt/media/image1.png': pngBytes(),
    });
    expect(codeOf(bytes)).toBe('pptx_corrupt');
  });

  it('rejects a resolved media path the archive does not actually contain', () => {
    const bytes = buildPptxWithSlideFiles([blipShapeXml(2, 'rId1')], {
      'ppt/slides/_rels/slide1.xml.rels': mediaRelsXml([['rId1', '../media/missing.png']]),
    });
    expect(codeOf(bytes)).toBe('pptx_corrupt');
  });

  it.each(SIGNATURE_FIXTURES)('types media whose bytes sniff as %s', (type, mediaBytes) => {
    const bytes = buildPptxWithSlideFiles([blipShapeXml(2, 'rId1')], {
      'ppt/slides/_rels/slide1.xml.rels': mediaRelsXml([['rId1', '../media/item.bin']]),
      'ppt/media/item.bin': mediaBytes,
    });
    const result = extractPptx(bytes);
    expect(result.slides[0]?.media).toEqual([{ bytes: mediaBytes, type }]);
  });

  it('extracts media from the correct slide when only some slides carry it', () => {
    const bytes = buildPptxWithSlideFiles([shapeXml([['Slide 1 text']], 2), blipShapeXml(2, 'rId1')], {
      'ppt/slides/_rels/slide2.xml.rels': mediaRelsXml([['rId1', '../media/image1.png']]),
      'ppt/media/image1.png': pngBytes(),
    });
    const result = extractPptx(bytes);
    expect(result.slides[0]?.media).toEqual([]);
    expect(result.slides[1]?.media).toEqual([{ bytes: pngBytes(), type: 'image/png' }]);
  });
});

describe('extractPptx provenance', () => {
  it('reports no title or source when neither docProps/core.xml nor a title placeholder is present', () => {
    const bytes = buildPptx([shapeXml([['Just a plain slide']], 2)]);
    expect(extractPptx(bytes).provenance).toEqual({});
  });

  it('extracts a declared title and source from docProps/core.xml', () => {
    const bytes = buildPptxWithSlideFiles([shapeXml([['Slide text']], 2)], {
      'docProps/core.xml': corePropsXml({ title: 'Amazing Grace', creator: 'Traditional' }),
    });
    expect(extractPptx(bytes).provenance).toEqual({ title: 'Amazing Grace', source: 'Traditional' });
  });

  it('leaves title and source absent when docProps/core.xml declares them blank', () => {
    const bytes = buildPptxWithSlideFiles([shapeXml([['Slide text']], 2)], {
      'docProps/core.xml': corePropsXml({ title: '   ', creator: '' }),
    });
    expect(extractPptx(bytes).provenance).toEqual({});
  });

  it("falls back to the first slide's own title placeholder when core.xml has no title", () => {
    const bytes = buildPptxWithSlideFiles([titlePlaceholderXml([['Fallback Title']], 2, 'title')], {});
    expect(extractPptx(bytes).provenance).toEqual({ title: 'Fallback Title' });
  });

  it('recognizes a ctrTitle placeholder the same way as a title placeholder', () => {
    const bytes = buildPptxWithSlideFiles([titlePlaceholderXml([['Centered Title']], 2, 'ctrTitle')], {});
    expect(extractPptx(bytes).provenance).toEqual({ title: 'Centered Title' });
  });

  it('treats a body placeholder with no type as not a title', () => {
    // An omitted `type` defaults to a body placeholder, not a title one, per the OOXML schema.
    const bytes = buildPptxWithSlideFiles([titlePlaceholderXml([['Not a title']], 2)], {});
    expect(extractPptx(bytes).provenance).toEqual({});
  });

  it('treats a whitespace-only title placeholder as no title at all', () => {
    const bytes = buildPptxWithSlideFiles([titlePlaceholderXml([['   ']], 2, 'title')], {});
    expect(extractPptx(bytes).provenance).toEqual({});
  });

  it('prefers a declared core.xml title over the first slide\'s placeholder fallback', () => {
    const bytes = buildPptxWithSlideFiles([titlePlaceholderXml([['Placeholder Title']], 2, 'title')], {
      'docProps/core.xml': corePropsXml({ title: 'Declared Title' }),
    });
    expect(extractPptx(bytes).provenance).toEqual({ title: 'Declared Title' });
  });

  it('uses the first title placeholder when a slide somehow carries more than one', () => {
    const bytes = buildPptxWithSlideFiles(
      [titlePlaceholderXml([['First Title']], 2, 'title') + titlePlaceholderXml([['Second Title']], 3, 'ctrTitle')],
      {},
    );
    expect(extractPptx(bytes).provenance).toEqual({ title: 'First Title' });
  });

  it('ignores a title placeholder on any slide but the first', () => {
    const bytes = buildPptxWithSlideFiles(
      [shapeXml([['Slide 1, no title placeholder']], 2), titlePlaceholderXml([['Slide 2 title']], 2, 'title')],
      {},
    );
    expect(extractPptx(bytes).provenance).toEqual({});
  });

  it('reads a declared source independently of where the title came from', () => {
    const bytes = buildPptxWithSlideFiles([titlePlaceholderXml([['Fallback Title']], 2, 'title')], {
      'docProps/core.xml': corePropsXml({ creator: 'Someone' }),
    });
    expect(extractPptx(bytes).provenance).toEqual({ title: 'Fallback Title', source: 'Someone' });
  });
});
