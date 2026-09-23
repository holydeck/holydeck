// Turning an uploaded PowerPoint file into ordered slides and raw text blocks, deterministically and
// offline. A `.pptx` is a ZIP archive of Office Open XML parts; the part that orders the slides is
// `ppt/presentation.xml` (its `<p:sldIdLst>` lists one `<p:sldId r:id="…">` per slide, in show order),
// the relationship IDs it lists are resolved to slide part paths through `ppt/_rels/presentation.xml.rels`,
// and each resolved `ppt/slides/slideN.xml` part holds the slide's shapes (`<p:sp>`), each shape's text
// body (`<p:txBody>`) holding one `<a:p>` per paragraph and one `<a:t>` per run of text within it.
//
// Nothing here interprets what it finds. A slide's text blocks are one raw string per text-bearing
// shape — its paragraphs joined by "\n", its runs concatenated with no separator, exactly as authored —
// in the shape's document order. No language detection, no repeat-marker parsing, no duplicate detection,
// no classification: that reading is PPTX-04's job, done on top of this deterministic list rather than
// folded into it (script separation and repeat-marker detection live in the sibling `pptx-content.ts`,
// as pure functions over one raw text block). And as with `sermon-ai.ts`, nothing reaches the filesystem —
// `extractPptx` either returns the full result or throws before building any of it; there is no partial
// result for a caller to receive.
//
// T69 adds one more list to each slide: its embedded media, discovered the same non-interpretive way as
// its text — following the `<a:blip r:embed>` references a slide's shapes make, through that slide's own
// `_rels` part, to the `ppt/media/…` bytes they name and the media type those bytes sniff as. Still just
// discovery, not judgment: registering that media anywhere durable is `apps/app`'s job (`pptx-import.ts`),
// since this package stays free of any `@holydeck/*` dependency and of the filesystem and database alike.
//
// T117 (PPTX-04's remaining "extracts available title/source provenance" clause) adds one more reading of
// the same kind: whatever the package's own `docProps/core.xml` core-properties part states about itself
// — its declared `<dc:title>` and `<dc:creator>` — read as-is, the same "the package claims it, we report
// it" discovery this file already does for media, never guessed at when the part is absent or says
// nothing. A title also falls back to the first slide's own title placeholder when the core-properties
// part has none (see `PptxProvenance`). Duplicate detection itself — comparing a discovered title against
// a HolyDeck song already on file — needs a live content library to compare against, so, like media
// registration, it stays `apps/app`'s job (`pptx-import.ts`), not this dependency-free package's.

import { load } from 'cheerio';
import { unzipSync } from 'fflate';
import { posix } from 'node:path';
import { HolyDeckError } from './messages.js';
import type { CheerioAPI } from 'cheerio';

/** The v1 media/font types embedded slide media can sniff as — the same set `@holydeck/contracts/media`'s
 *  `MEDIA_TYPES` declares, restated here (not imported) per T69 ruling 2. */
export type PptxMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'video/mp4'
  | 'font/woff2'
  | 'font/ttf'
  | 'font/otf';

/** One embedded media item a slide's `<a:blip r:embed>` resolved to: its raw bytes and sniffed type. */
export interface PptxSlideMedia {
  bytes: Uint8Array;
  type: PptxMediaType;
}

/** An embedded media reference `extractPptx` found but could not type — its bytes matched none of the v1
 *  formats — and so left out of its slide's `media` list rather than failing the whole extraction. */
export interface PptxSkippedMedia {
  slideIndex: number;
  relationshipId: string;
  target: string;
}

/** One slide's text-bearing shapes, in document order, each exactly as its runs and paragraphs read, and
 *  its embedded media, in the order its `<a:blip>` references appear in the slide's XML. */
export interface PptxSlide {
  textBlocks: string[];
  media: PptxSlideMedia[];
}

/** What the package itself states about its own title and where it came from — read, never guessed: each
 *  field is present only when the package actually declares it (T117, PPTX-04's "extracts available
 *  title/source provenance" clause). `title` prefers the core-properties `<dc:title>` and falls back to
 *  the first slide's own title-placeholder text when that part has none or says nothing. `source` reads
 *  the core-properties `<dc:creator>` only — Dublin Core's own "who produced this" field, and the closest
 *  single core-properties field to "where this came from"; `<dc:subject>` names a topic, not an origin,
 *  so it is deliberately not used here (a disclosed ruling, not an oversight). */
export interface PptxProvenance {
  title?: string;
  source?: string;
}

/** A presentation's slides, in the order the show would present them, every embedded media reference
 *  found across all of them that could not be typed (see `PptxSkippedMedia`), and whatever title/source
 *  the package itself declares (see `PptxProvenance`). */
export interface ExtractedPptx {
  slides: PptxSlide[];
  skippedMedia: PptxSkippedMedia[];
  provenance: PptxProvenance;
}

const PRESENTATION_PART = 'ppt/presentation.xml';
const RELATIONSHIPS_PART = 'ppt/_rels/presentation.xml.rels';

/** Bounds on `openArchive`'s own decompression (AUTH-13): more entries than `PPTX_MAX_ENTRIES`, any
 *  single entry decompressing past `PPTX_MAX_ENTRY_BYTES`, or the whole archive decompressing past
 *  `PPTX_MAX_TOTAL_BYTES`, is refused rather than decompressed — bounding what a malformed or hostile
 *  `.pptx` can do to the process parsing it. Checked twice: once against fflate's own declared
 *  `originalSize` while unzipping (cheap, catches the common case immediately), and again against every
 *  entry's actual inflated `byteLength` once `unzipSync` returns, since `originalSize` is attacker-declared
 *  per fflate's own docs and a crafted archive could under-declare it. */
export const PPTX_MAX_ENTRIES = 2000;
export const PPTX_MAX_ENTRY_BYTES = 50 * 1024 * 1024;
export const PPTX_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

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
  const skippedMedia: PptxSkippedMedia[] = [];
  let titlePlaceholder: string | undefined;
  const slides = slideParts.map((path, slideIndex) => {
    const $slide = readXmlPart(entries, path);
    const { media, skipped } = extractSlideMedia(entries, path, $slide, slideIndex);
    skippedMedia.push(...skipped);
    // Only the first slide is checked (see `extractTitlePlaceholder`'s own doc comment for why).
    if (slideIndex === 0) titlePlaceholder = extractTitlePlaceholder($slide);
    return { textBlocks: extractTextBlocks($slide), media };
  });
  return { slides, skippedMedia, provenance: extractProvenance(entries, titlePlaceholder) };
}

/** Rejects an entry name that, once normalized, is absolute or escapes upward out of the archive (path
 *  traversal), or that carries a NUL byte or a backslash — a Windows-style separator this package's
 *  POSIX-only path handling never expects. */
function isSafeEntryName(name: string): boolean {
  if (name.includes('\0') || name.includes('\\')) return false;
  const normalized = posix.normalize(name);
  return !normalized.startsWith('/') && normalized !== '..' && !normalized.startsWith('../');
}

function openArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  let entryCount = 0;
  let declaredTotal = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter(file) {
        entryCount += 1;
        if (entryCount > PPTX_MAX_ENTRIES) {
          throw new HolyDeckError('pptx_too_many_entries', { max: PPTX_MAX_ENTRIES });
        }
        if (file.originalSize > PPTX_MAX_ENTRY_BYTES) {
          throw new HolyDeckError('pptx_entry_too_large', { name: file.name, max: PPTX_MAX_ENTRY_BYTES });
        }
        declaredTotal += file.originalSize;
        if (declaredTotal > PPTX_MAX_TOTAL_BYTES) {
          throw new HolyDeckError('pptx_archive_too_large', { max: PPTX_MAX_TOTAL_BYTES });
        }
        if (!isSafeEntryName(file.name)) {
          throw new HolyDeckError('pptx_unsafe_entry_name', { name: file.name });
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof HolyDeckError) throw error;
    throw new HolyDeckError('pptx_corrupt', { reason: reasonOf(error) });
  }
  // TOCTOU re-check: `originalSize` above is attacker-declared, so re-verify the limits against what
  // actually came out of the archive before trusting it any further.
  let actualTotal = 0;
  for (const [name, entryBytes] of Object.entries(entries)) {
    if (entryBytes.byteLength > PPTX_MAX_ENTRY_BYTES) {
      throw new HolyDeckError('pptx_entry_too_large', { name, max: PPTX_MAX_ENTRY_BYTES });
    }
    actualTotal += entryBytes.byteLength;
    if (actualTotal > PPTX_MAX_TOTAL_BYTES) {
      throw new HolyDeckError('pptx_archive_too_large', { max: PPTX_MAX_TOTAL_BYTES });
    }
  }
  return entries;
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

function parseRelationships(raw: Uint8Array): Map<string, string> {
  const $rels = parseXmlPart(raw);
  const map = new Map<string, string>();
  $rels('Relationship').each((_, el) => {
    const id = $rels(el).attr('Id');
    const target = $rels(el).attr('Target');
    if (id !== undefined && target !== undefined) map.set(id, target);
  });
  return map;
}

function readRelationships(entries: Record<string, Uint8Array>): Map<string, string> {
  const raw = entries[RELATIONSHIPS_PART];
  if (raw === undefined) {
    throw new HolyDeckError('pptx_corrupt', { reason: `no ${RELATIONSHIPS_PART} part to resolve slide order` });
  }
  return parseRelationships(raw);
}

/**
 * A slide's own embedded media: every `<a:blip r:embed="…">` in its XML (the standard OOXML picture-fill
 * reference — `r:link` and non-`<a:blip>` embed mechanisms are out of scope for v1, per T69 ruling 5),
 * resolved through that slide's `ppt/slides/_rels/slideN.xml.rels` part the same way `resolveSlideOrder`
 * resolves the presentation's own relationships. A slide with no `_rels` part simply has no embedded
 * media — not an error, and not worth scanning its shapes for `<a:blip>` first to tell the two cases
 * apart, since a slide with genuine picture-fills always carries the `_rels` part that names their
 * targets. A `r:embed` id the `_rels` part does not know, or a target part the archive does not contain,
 * is `pptx_corrupt` — the same "package claims a reference it cannot deliver" break `resolveSlideOrder`
 * already treats that way. A target that IS in the archive but whose bytes sniff as no v1 media type is
 * skipped rather than failing the whole extraction (T69 ruling 5); the caller collects why into
 * `skippedMedia` instead of dropping it.
 */
function extractSlideMedia(
  entries: Record<string, Uint8Array>,
  slidePath: string,
  $slide: CheerioAPI,
  slideIndex: number,
): { media: PptxSlideMedia[]; skipped: PptxSkippedMedia[] } {
  const relsPath = posix.join(posix.dirname(slidePath), '_rels', `${posix.basename(slidePath)}.rels`);
  const relsRaw = entries[relsPath];
  if (relsRaw === undefined) return { media: [], skipped: [] };
  const rels = parseRelationships(relsRaw);
  const embedIds: string[] = [];
  $slide('a\\:blip').each((_, el) => {
    const relId = $slide(el).attr('r:embed');
    if (relId !== undefined) embedIds.push(relId);
  });
  const media: PptxSlideMedia[] = [];
  const skipped: PptxSkippedMedia[] = [];
  for (const relId of embedIds) {
    const target = rels.get(relId);
    if (target === undefined) {
      throw new HolyDeckError('pptx_corrupt', {
        reason: `embedded media relationship "${relId}" is missing from ${relsPath}`,
      });
    }
    const mediaPath = posix.join(posix.dirname(slidePath), target);
    const raw = entries[mediaPath];
    if (raw === undefined) {
      throw new HolyDeckError('pptx_corrupt', { reason: `referenced media part "${mediaPath}" is missing from the archive` });
    }
    const type = sniffPptxMediaType(raw);
    if (type === undefined) {
      skipped.push({ slideIndex, relationshipId: relId, target: mediaPath });
      continue;
    }
    media.push({ bytes: raw, type });
  }
  return { media, skipped };
}

const matchesSignature = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean =>
  signature.every((value, index) => bytes[offset + index] === value);

/**
 * Duplicates `@holydeck/contracts/media`'s `sniffMediaType` byte-for-byte, deliberately: `packages/core`
 * stays free of any `@holydeck/*` dependency (T69 ruling 2), so the same magic-byte detection is kept
 * here rather than imported. `apps/app`'s registration step re-sniffs the same bytes through the real one
 * when it calls `MediaLibrary.upload`, so the two are never trusted to agree silently — only ever proven
 * to by both packages' own tests passing against the same signature bytes.
 */
function sniffPptxMediaType(bytes: Uint8Array): PptxMediaType | undefined {
  if (matchesSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (matchesSignature(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    matchesSignature(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    matchesSignature(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return 'image/gif';
  }
  if (matchesSignature(bytes, [0x52, 0x49, 0x46, 0x46]) && matchesSignature(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  if (matchesSignature(bytes, [0x66, 0x74, 0x79, 0x70], 4)) return 'video/mp4';
  if (matchesSignature(bytes, [0x77, 0x4f, 0x46, 0x32])) return 'font/woff2';
  if (matchesSignature(bytes, [0x00, 0x01, 0x00, 0x00])) return 'font/ttf';
  if (matchesSignature(bytes, [0x4f, 0x54, 0x54, 0x4f])) return 'font/otf';
  return undefined;
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

const TITLE_PLACEHOLDER_TYPES = new Set(['title', 'ctrTitle']);

/**
 * The first slide's own title-placeholder text, when it has one: a `<p:sp>` shape whose `<p:ph>` names
 * `type="title"` or `type="ctrTitle"` (OOXML's two standard title-placeholder types — an omitted `type`
 * defaults to a body placeholder, not a title one, per the OOXML schema), read the same way
 * `extractTextBlocks` reads any other shape's text: paragraphs joined by "\n", runs concatenated with no
 * separator. Only the first slide is checked, deliberately: a later slide's own title placeholder names
 * that slide's own heading, not the presentation's, and `PptxProvenance.title` asks for the
 * presentation's title, not whichever slide happens to have one. A slide with no title placeholder at
 * all, or one that is empty once trimmed, contributes nothing — a disclosed fallback source, used only
 * when `docProps/core.xml` names no title of its own (see `extractProvenance`).
 */
function extractTitlePlaceholder($slide: CheerioAPI): string | undefined {
  let found: string | undefined;
  $slide('p\\:sp').each((_, shape) => {
    if (found !== undefined) return;
    const type = $slide(shape).find('p\\:ph').attr('type');
    if (type === undefined || !TITLE_PLACEHOLDER_TYPES.has(type)) return;
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
    const text = paragraphs.join('\n').trim();
    if (text.length > 0) found = text;
  });
  return found;
}

const CORE_PROPERTIES_PART = 'docProps/core.xml';

const nonEmpty = (text: string): string | undefined => {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * The package's own declared title and source, read the same non-interpretive way as everything else in
 * this file (see the module header). `docProps/core.xml` — OOXML's standard core-properties part — may
 * or may not be present in the archive at all; its absence is "no discoverable title/source", not
 * corruption, since not every authoring tool writes it and PowerPoint itself allows it to be left blank.
 * `title` prefers the core-properties `<dc:title>`, falling back to the first slide's own title
 * placeholder (`extractTitlePlaceholder`) only when the core-properties part has none or names an empty
 * title. `source` reads only the core-properties `<dc:creator>` — see `PptxProvenance`'s own doc comment
 * for why `<dc:subject>` is not used. Neither field is ever guessed at: a blank or absent value stays
 * absent rather than falling back to something invented.
 */
function extractProvenance(entries: Record<string, Uint8Array>, titlePlaceholder: string | undefined): PptxProvenance {
  const raw = entries[CORE_PROPERTIES_PART];
  const core = raw === undefined ? undefined : parseXmlPart(raw);
  const declaredTitle = core === undefined ? undefined : nonEmpty(core('dc\\:title').first().text());
  const source = core === undefined ? undefined : nonEmpty(core('dc\\:creator').first().text());
  const title = declaredTitle ?? titlePlaceholder;
  return { ...(title === undefined ? {} : { title }), ...(source === undefined ? {} : { source }) };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
