// Turns an uploaded `.pptx` file into the per-slide result PPTX-04's later steps (T70's labelling
// review, T71's SongBody assembly) build on: `packages/core`'s deterministic extraction pass, with each
// slide's embedded media actually registered through the T54 media manifest (`./media.js`) — the one
// piece of PPTX-04 that is inherently stateful and so cannot live in the dependency-free `packages/core`
// (see T69 ruling 1).
//
// Script separation and repeat-marker detection (`@holydeck/core/pptx-content`) are deliberately NOT run
// here: they are pure functions over `slide.textBlocks`, already fully testable in `packages/core`, and
// applying them is a later task's job (T71) once it assembles an actual `SongBody`. This module's job
// stops at text-block pass-through plus registered media — no labelling, no title/copyright extraction,
// no duplicate-song detection (T69 ruling 6).

import { createHash } from 'node:crypto';

import { extractPptx } from '@holydeck/core/pptx';

import { MediaError, mediaLibraryOn } from './media.js';

import type { ExtractedPptx, PptxSkippedMedia } from '@holydeck/core/pptx';
import type { MediaLibrary, MediaLibraryOptions, MediaRecord } from './media.js';
import type { RepositoryDb } from './repositories.js';

export type { PptxSkippedMedia };

export interface PptxImportSlide {
  readonly textBlocks: readonly string[];
  readonly media: readonly MediaRecord[];
}

export interface PptxImportResult {
  readonly slides: readonly PptxImportSlide[];
  readonly skippedMedia: readonly PptxSkippedMedia[];
}

export interface PptxImport {
  import(context: unknown, bytes: Uint8Array): Promise<PptxImportResult>;
}

const hashOf = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * Registers one extracted media item through the T54 manifest, reusing the existing record when the
 * same bytes were already uploaded — a case the task's rulings did not anticipate: the same embedded
 * picture (a background, a logo) can realistically be referenced from more than one slide in the same
 * deck, and `MediaLibrary.upload` throws `MediaError('duplicate', …)` on a second upload of identical
 * bytes rather than returning the existing record. Catching that specific refusal and looking the
 * existing record up by its content hash keeps a multi-slide reference from failing the whole import.
 */
async function registerOne(library: MediaLibrary, context: unknown, bytes: Uint8Array): Promise<MediaRecord> {
  try {
    return await library.upload(context, { bytes });
  } catch (error) {
    if (error instanceof MediaError && error.kind === 'duplicate') {
      const hash = hashOf(bytes);
      const existing = (await library.list(context)).find((record) => record.manifest.hash === hash);
      if (existing !== undefined) return existing;
    }
    throw error;
  }
}

export function pptxImportOn(db: RepositoryDb, options: MediaLibraryOptions): PptxImport {
  const library = mediaLibraryOn(db, options);
  return {
    import: async (context, bytes) => {
      const extracted: ExtractedPptx = extractPptx(bytes);
      const slides: PptxImportSlide[] = [];
      for (const slide of extracted.slides) {
        const media: MediaRecord[] = [];
        for (const item of slide.media) {
          media.push(await registerOne(library, context, item.bytes));
        }
        slides.push({ textBlocks: slide.textBlocks, media });
      }
      return { slides, skippedMedia: extracted.skippedMedia };
    },
  };
}
