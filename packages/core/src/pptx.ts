// Turning an uploaded PowerPoint file into ordered slides and raw text blocks, deterministically and
// offline. A `.pptx` is a ZIP archive of Office Open XML parts; the part that orders the slides is
// `ppt/presentation.xml` (its `<p:sldIdLst>` lists one `<p:sldId r:id="…">` per slide, in show order),
// the relationship IDs it lists are resolved to slide part paths through `ppt/_rels/presentation.xml.rels`,
// and each resolved `ppt/slides/slideN.xml` part holds the slide's shapes (`<p:sp>`), each shape's text
// body (`<p:txBody>`) holding one `<a:p>` per paragraph and one `<a:t>` per run of text within it.
//
// Nothing here interprets what it finds. A slide's text blocks are one raw string per text-bearing
// shape — its paragraphs joined by "\n", its runs concatenated with no separator, exactly as authored —
// in the shape's document order. No language detection, no repeat-marker parsing, no title or source
// extraction, no duplicate detection, no classification: that reading is PPTX-04's job, done on top of
// this deterministic list rather than folded into it. And as with `sermon-ai.ts`, nothing reaches the
// filesystem — `extractPptx` either returns the full result or throws before building any of it; there
// is no partial result for a caller to receive.

import { load } from 'cheerio';
import { unzipSync } from 'fflate';
import { posix } from 'node:path';
import { HolyDeckError } from './messages.js';
import type { CheerioAPI } from 'cheerio';

/** One slide's text-bearing shapes, in document order, each exactly as its runs and paragraphs read. */
export interface PptxSlide {
  textBlocks: string[];
}

/** A presentation's slides, in the order the show would present them. */
export interface ExtractedPptx {
  slides: PptxSlide[];
}

const PRESENTATION_PART = 'ppt/presentation.xml';
const RELATIONSHIPS_PART = 'ppt/_rels/presentation.xml.rels';

const decoder = new TextDecoder('utf-8');

/**
 * Reads a `.pptx` file's slides and their raw text, in show order. Throws a `HolyDeckError` — never a
 * partial result — when the bytes are not readable as a ZIP archive (`pptx_corrupt`), when the archive
 * does not look like an OOXML presentation package (`pptx_unsupported`), or when it is one but lists no
 * slides (`pptx_empty`). A structurally broken presentation package — a slide relationship or part that
 * `ppt/presentation.xml` points at but the archive does not contain — is also `pptx_corrupt`: the
 * package claims an order it cannot deliver.
 */
export function extractPptx(bytes: Uint8Array): ExtractedPptx {
  const entries = openArchive(bytes);
  const presentation = requirePresentationPart(entries);
  const slideParts = resolveSlideOrder(presentation, entries);
  if (slideParts.length === 0) throw new HolyDeckError('pptx_empty');
  const slides = slideParts.map((path) => ({ textBlocks: extractTextBlocks(readXmlPart(entries, path)) }));
  return { slides };
}

function openArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch (error) {
    throw new HolyDeckError('pptx_corrupt', { reason: reasonOf(error) });
  }
}

function requirePresentationPart(entries: Record<string, Uint8Array>): CheerioAPI {
  const raw = entries[PRESENTATION_PART];
  if (raw === undefined) {
    throw new HolyDeckError('pptx_unsupported', { reason: `no ${PRESENTATION_PART} part in the archive` });
  }
  return parseXmlPart(raw);
}

// htmlparser2's XML mode never throws — an unparseable byte sequence just yields a sparse or empty DOM —
// so every "corrupt" case below is caught structurally (a part or relationship the package points at but
// does not contain), not as an exception out of the parser itself.
function parseXmlPart(raw: Uint8Array): CheerioAPI {
  return load(decoder.decode(raw), { xmlMode: true });
}

function readXmlPart(entries: Record<string, Uint8Array>, path: string): CheerioAPI {
  const raw = entries[path];
  if (raw === undefined) {
    throw new HolyDeckError('pptx_corrupt', { reason: `referenced part "${path}" is missing from the archive` });
  }
  return parseXmlPart(raw);
}

/**
 * The slide part paths in show order: every `r:id` on a `<p:sldId>` in `ppt/presentation.xml`, resolved
 * through `ppt/_rels/presentation.xml.rels`. An empty `<p:sldIdLst>` (or none at all) is a presentation
 * with nothing to extract, reported by the caller as `pptx_empty`; a `r:id` the relationships part does
 * not know, or a target part the archive does not contain, means the package cannot deliver the order it
 * claims and is `pptx_corrupt`.
 */
function resolveSlideOrder($presentation: CheerioAPI, entries: Record<string, Uint8Array>): string[] {
  const relIds: string[] = [];
  $presentation('p\\:sldId').each((_, el) => {
    const relId = $presentation(el).attr('r:id');
    if (relId !== undefined) relIds.push(relId);
  });
  if (relIds.length === 0) return [];
  const rels = readRelationships(entries);
  return relIds.map((relId) => {
    const target = rels.get(relId);
    if (target === undefined) {
      throw new HolyDeckError('pptx_corrupt', {
        reason: `slide relationship "${relId}" is missing from ${RELATIONSHIPS_PART}`,
      });
    }
    // Targets in a part's .rels file are relative to that part's own directory ("slides/slide1.xml" from
    // "ppt/presentation.xml" means "ppt/slides/slide1.xml"); `posix.join` also normalizes a stray "../".
    return posix.join('ppt', target);
  });
}

function readRelationships(entries: Record<string, Uint8Array>): Map<string, string> {
  const raw = entries[RELATIONSHIPS_PART];
  if (raw === undefined) {
    throw new HolyDeckError('pptx_corrupt', { reason: `no ${RELATIONSHIPS_PART} part to resolve slide order` });
  }
  const $rels = parseXmlPart(raw);
  const map = new Map<string, string>();
  $rels('Relationship').each((_, el) => {
    const id = $rels(el).attr('Id');
    const target = $rels(el).attr('Target');
    if (id !== undefined && target !== undefined) map.set(id, target);
  });
  return map;
}

/**
 * One raw string per text-bearing shape on the slide (`<p:sp>`, selected wherever it sits — including
 * nested inside a `<p:grpSp>` group, since the selector reads the whole part rather than only the top
 * level), in document order. A shape's paragraphs (`<a:p>`) join with "\n"; within a paragraph, every
 * run's text (`<a:t>`, however it is wrapped — a plain run or a field) concatenates with no separator,
 * since a run is only a formatting split within one continuous line. A shape with no text at all — a
 * picture frame, an empty placeholder — contributes no block; this package does not distinguish "shape
 * with no text" from "shape with only whitespace text", since scoring that difference is interpretation.
 */
function extractTextBlocks($slide: CheerioAPI): string[] {
  const blocks: string[] = [];
  $slide('p\\:sp').each((_, shape) => {
    const paragraphs: string[] = [];
    $slide(shape)
      .find('a\\:p')
      .each((_, paragraph) => {
        let line = '';
        $slide(paragraph)
          .find('a\\:t')
          .each((_, run) => {
            line += $slide(run).text();
          });
        paragraphs.push(line);
      });
    const text = paragraphs.join('\n');
    if (text.length > 0) blocks.push(text);
  });
  return blocks;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
