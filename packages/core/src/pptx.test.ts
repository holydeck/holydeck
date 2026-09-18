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

describe('extractPptx rejections', () => {
  function codeOf(bytes: Uint8Array): string {
    try {
      extractPptx(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(HolyDeckError);
      return (error as HolyDeckError).code;
    }
    throw new Error('expected extractPptx to throw');
  }

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
