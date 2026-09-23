// Turns an uploaded `.pptx` file into the per-slide result PPTX-04's later steps (T70's labelling
// review, T71's SongBody assembly) build on: `packages/core`'s deterministic extraction pass, with each
// slide's embedded media actually registered through the T54 media manifest (`./media.js`) — the one
// piece of PPTX-04 that is inherently stateful and so cannot live in the dependency-free `packages/core`
// (see T69 ruling 1).
//
// Script separation and repeat-marker detection (`@holydeck/core/pptx-content`) are deliberately NOT run
// here: they are pure functions over `slide.textBlocks`, already fully testable in `packages/core`, and
// applying them is a later task's job (T71) once it assembles an actual `SongBody`. This module's job
// stops at text-block pass-through plus registered media, plus the two more things T117 completes
// PPTX-04 with below — no labelling still (T70's own job).
//
// T117 adds `provenance` (passed straight through from `packages/core`'s own discovery, see `pptx.ts`)
// and a possible-duplicate warning — the second inherently stateful half of PPTX-04, needing a live
// `./library.js` read for the same reason media registration needs a live `./media.js` write. Detecting
// a duplicate never blocks the import: it is data on the result, not a refusal, so the caller acts on it
// the same way a caller already chooses `create` or `append` on `PptxCommitTarget` — proceeding is
// `commit(..., { mode: 'create', ... })` same as always, and choosing to merge is
// `commit(..., { mode: 'append', id: candidate.id })` against T71's already-landed path, never a second
// import mechanism of this module's own.

import { createHash } from 'node:crypto';

import { normalizePptxTitle } from '@holydeck/core/pptx-content';

import { requestContext } from './context.js';
import { LIBRARY_PERMISSIONS, libraryOn } from './library.js';
import { MEDIA_ASSET_PERMISSIONS, MediaError, mediaLibraryOn } from './media.js';
import { inProcessPptxRunner } from './pptx-isolated.js';
import { QUEUE_PERMISSIONS } from './queue.js';

import type { ExtractedPptx, PptxProvenance, PptxSkippedMedia } from '@holydeck/core/pptx';
import type { RequestContext } from './context.js';
import type { LibraryStore } from './library.js';
import type { MediaLibrary, MediaLibraryOptions, MediaRecord } from './media.js';
import type { IsolatedPptxRunner } from './pptx-isolated.js';
import type { RepositoryDb } from './repositories.js';

export type { PptxProvenance, PptxSkippedMedia };

export interface PptxImportSlide {
  readonly textBlocks: readonly string[];
  readonly media: readonly MediaRecord[];
}

/** The warning PPTX-04 asks for: an existing song whose own title normalizes to the same title this
 *  import discovered (see `PptxProvenance.title` and `normalizePptxTitle`). Never a refusal —
 *  `PptxImport.import` returns it as data on an otherwise-ordinary result, and what to do with it is the
 *  caller's own choice: proceed by committing `{ mode: 'create', ... }` same as always, or merge by
 *  committing `{ mode: 'append', id: candidate.id }` against T71's already-landed `PptxCommit`. */
export interface PptxDuplicateCandidate {
  readonly id: string;
  readonly title: string;
}

export interface PptxImportResult {
  readonly slides: readonly PptxImportSlide[];
  readonly skippedMedia: readonly PptxSkippedMedia[];
  /** Whatever title/source the package itself declared, passed through from `packages/core`'s own
   *  discovery exactly as it read it (see `pptx.ts`'s `PptxProvenance`) — absent fields stay absent
   *  rather than guessed. */
  readonly provenance: PptxProvenance;
  /** Present only when an existing song's title is a possible duplicate of this import's own discovered
   *  title; absent whenever no title was discovered at all, or none of the library's songs match it. */
  readonly duplicate?: PptxDuplicateCandidate;
}

export interface PptxImport {
  import(context: unknown, bytes: Uint8Array): Promise<PptxImportResult>;
}

/** Grants the same media-registration and queueing permissions `./media.js`'s own `mediaContext` does,
 *  plus the one this module adds beyond T69: reading the content library, to compare a discovered title
 *  against the songs already on file for T117's duplicate-detection warning. */
export function pptxImportContext(actor: string, correlationId: string): RequestContext {
  return requestContext({
    actor,
    permissions: [...Object.values(MEDIA_ASSET_PERMISSIONS), QUEUE_PERMISSIONS.enqueue, LIBRARY_PERMISSIONS.read],
    correlationId,
  });
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

/**
 * The duplicate-detection warning itself: whether an existing song's own title, once normalized the same
 * way, reads as the same title this import discovered. No title discovered at all leaves nothing to
 * compare against, so it is never flagged. Matching only by normalized title (see `normalizePptxTitle` —
 * trimmed, whitespace-collapsed, case-folded, nothing fancier) is a disclosed v1 limitation, the same
 * "documented limitation, not a bug to fix by guessing" precedent `pptx-content.ts` already sets for its
 * own pure readings: no fuzzy matching, no comparison against slide content itself. The first match in
 * the library's own listing order wins when more than one song's title happens to normalize the same way.
 */
async function findDuplicate(
  catalogue: LibraryStore,
  context: unknown,
  title: string | undefined,
): Promise<PptxDuplicateCandidate | undefined> {
  if (title === undefined) return undefined;
  const normalized = normalizePptxTitle(title);
  if (normalized.length === 0) return undefined;
  const songs = await catalogue.list(context, { kind: 'song' });
  const match = songs.find((song) => normalizePptxTitle(song.title) === normalized);
  return match === undefined ? undefined : { id: match.stamp.id, title: match.title };
}

export interface PptxImportOptions extends MediaLibraryOptions {
  /** AUTH-13: how the raw bytes are actually parsed. Defaults to the in-process, un-isolated runner —
   *  the right choice for tests that already exercise `packages/core`'s extraction directly and don't
   *  need a real OS thread to prove it works. Production wires `workerPptxRunner()` in (see main.ts),
   *  isolating parsing in its own `node:worker_threads` Worker. */
  readonly runner?: IsolatedPptxRunner;
}

export function pptxImportOn(db: RepositoryDb, options: PptxImportOptions): PptxImport {
  const library = mediaLibraryOn(db, options);
  const catalogue = libraryOn(db, options);
  const runner = options.runner ?? inProcessPptxRunner();
  return {
    import: async (context, bytes) => {
      const extracted: ExtractedPptx = await runner.run(bytes);
      const slides: PptxImportSlide[] = [];
      for (const slide of extracted.slides) {
        const media: MediaRecord[] = [];
        for (const item of slide.media) {
          media.push(await registerOne(library, context, item.bytes));
        }
        slides.push({ textBlocks: slide.textBlocks, media });
      }
      const duplicate = await findDuplicate(catalogue, context, extracted.provenance.title);
      return {
        slides,
        skippedMedia: extracted.skippedMedia,
        provenance: extracted.provenance,
        ...(duplicate === undefined ? {} : { duplicate }),
      };
    },
  };
}
