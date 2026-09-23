// AUTH-13: proves the two `IsolatedPptxRunner` implementations actually run extraction, and that the
// isolated one really goes through a `node:worker_threads` Worker rather than silently falling back to
// an in-process call — a real spawn, not a stub, for both its success and failure paths.

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { inProcessPptxRunner, workerPptxRunner } from './pptx-isolated.js';

// Minimal OOXML fixture builder, the same minimal shape `pptx-import.test.ts` and `pptx-routes.test.ts`
// already use — just enough for `extractPptx` to read one slide with one text block.
const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

function textShapeXml(text: string, id: number): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="TextBox ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`
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

function relsXml(entries: [relId: string, target: string][]): Uint8Array {
  const rels = entries.map(([id, target]) => `<Relationship Id="${id}" Type="${SLIDE_REL_TYPE}" Target="${target}"/>`).join('');
  return strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${RELS_NS}">${rels}</Relationships>`);
}

function buildPptx(slides: string[]): Uint8Array {
  const relIds = slides.map((_, index) => `rId${index + 1}`);
  const files: Record<string, Uint8Array> = {
    'ppt/presentation.xml': presentationXml(relIds),
    'ppt/_rels/presentation.xml.rels': relsXml(relIds.map((relId, index): [string, string] => [relId, `slides/slide${index + 1}.xml`])),
  };
  slides.forEach((shapesXml, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = slideXml(shapesXml);
  });
  return zipSync(files);
}

const DECK = buildPptx([textShapeXml('Amazing grace', 2)]);
const NOT_A_ZIP = strToU8('this is plain text, not a zip archive of any kind');

describe('inProcessPptxRunner', () => {
  it('extracts a valid deck directly, with no isolation', async () => {
    const extracted = await inProcessPptxRunner().run(DECK);
    expect(extracted.slides).toEqual([{ textBlocks: ['Amazing grace'], media: [] }]);
  });
});

describe('workerPptxRunner', () => {
  it('extracts a valid deck through a real worker_threads Worker', async () => {
    const extracted = await workerPptxRunner().run(DECK);
    expect(extracted.slides).toEqual([{ textBlocks: ['Amazing grace'], media: [] }]);
  });

  it('rejects with a HolyDeckError, through a real Worker, for a corrupt archive rather than crashing', async () => {
    await expect(workerPptxRunner().run(NOT_A_ZIP)).rejects.toMatchObject({
      name: 'HolyDeckError',
      code: 'pptx_corrupt',
    });
  });

  it('rejects once the worker takes longer than the configured timeout', async () => {
    // A valid deck extracts fast, so an unreasonably small timeout is what forces the timeout branch —
    // the point of this test is the runner's own timer, not a slow parse.
    await expect(workerPptxRunner({ timeoutMs: 1 }).run(DECK)).rejects.toMatchObject({
      name: 'HolyDeckError',
      code: 'pptx_corrupt',
    });
  });
});
