// The local render rehearsal (OFFL-03): the last gate before a service may be marked ready to present
// offline. Invariant 7 lets a service present offline only from a "capacity-checked, completely cached,
// hash-verified, locally rehearsed snapshot"; `preparation-storage.ts` is the capacity check,
// `preparation-cache.ts` is the middle two, and this file is the word that has no substitute — rehearsed.
//
// The three that come before it all reason about bytes: enough room for them, all of them present, each
// of them the bytes the manifest pinned. None of that is a promise that the service *draws*. A font the
// snapshot never pinned, a document pinned by a build whose renderer no longer accepts it, a slide that
// does not fit its box: every one of those passes a byte-perfect cache and fails on a wall. So this
// module renders the snapshot, here, out of the cache, and compares what came out against what the
// online render produced when the snapshot was pinned.
//
// There is no `fetch` in the clients it takes, and that absence is the design. A rehearsal that could
// reach a server would prove the server still answers, which is the one thing a service about to go
// offline does not need to know. Everything rendered here is read back out of the cache — twice, in
// fact: once by `planPreparationCache` to prove the cache holds what the manifest pinned, and once again
// to render from. The second read is the one that matters, because it is the copy a Sunday morning gets,
// and an eviction that lands between the two is reported rather than rendered around.
//
// What it does *not* do is re-test the renderer. REND-01's own guarantee is that one normalized render
// model produces byte-identical output across the editor preview, the thumbnail, the output view and the
// offline presenter, and `packages/renderer` owns the proof of it. The question here is a different one:
// do the inputs that survived into the cache still produce the model the online render was taken from?
// A divergence means the offline environment differs from the one the snapshot was pinned in — which is
// exactly the failure nobody discovers until the projector is on.
//
// Two vocabularies meet here and are deliberately kept apart. `packages/renderer/src/readiness.ts`
// grades a *slide* — text below the readable floor, content outside the safe area, media above its
// volume bound — and this module carries those findings through verbatim rather than re-encoding them,
// because re-deriving a verdict the renderer already reached is how two answers to one question start
// drifting. The codes below are about something else: whether this rehearsal proved anything at all.
// "The cache lost a document" and "the frame does not match what was recorded" are not slide defects and
// have no place in `ReadinessCode`, the same way `preparation-storage.ts` named its own three blockers
// rather than borrowing an enum that merely looked close enough.
//
// Nothing here is localized and nothing here is a sentence. A blocker carries a code, the document it
// belongs to and the digests behind it; the surface that shows one owns the wording.

import { prepareRenderModel } from '@holydeck/renderer/render-model';
import { frameBytes, renderPrepared } from '@holydeck/renderer/renderer';

import { digestOf, planPreparationCache, readCachedBytes, recordedDigestOf } from './preparation-cache.js';

import type { TextMeasurer } from '@holydeck/renderer/measure';
import type { AdministrativeRenderDefaults, ServiceRenderOverrides } from '@holydeck/renderer/output-profile';
import type { ReadinessFinding } from '@holydeck/renderer/readiness';
import type { RenderModelInput } from '@holydeck/renderer/render-model';
import type { RenderFrame } from '@holydeck/renderer/renderer';
import type {
  PinnedEntry,
  PreparationBytes,
  PreparationCacheLike,
  PreparationSubtleLike,
} from './preparation-cache.js';

/** The one digest form this module writes. Both separators are read — `recordedDigestOf` owns that
 *  grammar — and a reported digest is written one way so two that differ look different. */
export const FRAME_DIGEST_PREFIX = 'sha256:';

/**
 * A pinned entry the rehearsal renders: a render-model document, plus the digest of the frame rendering
 * it produced when the snapshot was pinned online.
 *
 * `frameHash` is what makes an entry a document. An entry without one is an asset — a picture, a video,
 * a font — which OFFL-02 caches and verifies and which nothing here hands to the renderer. Carrying the
 * discriminator on the entry rather than taking a second list is what makes it impossible to rehearse a
 * document the completeness check below never looked at.
 */
export interface RehearsalDocument extends PinnedEntry {
  /** The digest of `frameBytes(renderPrepared(...))` taken online, `sha256:<hex>` or `sha256-<hex>`. */
  readonly frameHash: string;
}

export const isRehearsalDocument = (entry: PinnedEntry): entry is RehearsalDocument =>
  typeof (entry as Partial<RehearsalDocument>).frameHash === 'string';

/**
 * Why a snapshot may not be marked ready to present offline. Each code names a different repair.
 *
 * The first two are about the snapshot as a whole and leave nothing rendered: there is no point
 * rehearsing a cache that is still missing bytes, and a snapshot with no render model in it has not been
 * rehearsed at all. The rest are about one document, and a document carries at most one of them — the
 * first thing that stopped it, since everything after it would be a guess.
 *
 * `render.diverged` and `render.blocked` are deliberately not one code. The first says this browser does
 * not reproduce the render the snapshot was pinned from — an environment to repair. The second says the
 * renderer drew the slide and refuses to call it fit to show — a layout to repair, and one that was
 * equally broken online. Merging them would make one reported problem mean two unrelated fixes.
 */
export type RehearsalBlocker =
  | { readonly code: 'cache.incomplete'; readonly pendingAssetIds: readonly string[] }
  | { readonly code: 'snapshot.noDocuments' }
  | { readonly code: 'document.frameHashUnknown'; readonly documentId: string }
  | { readonly code: 'document.notCached'; readonly documentId: string }
  /** `reason` is the name of what refused the bytes — `SyntaxError`, `TypeError` — never its message:
   *  a token a surface can branch on, not a sentence in one language. */
  | { readonly code: 'document.unreadable'; readonly documentId: string; readonly reason: string }
  | { readonly code: 'render.failed'; readonly documentId: string; readonly reason: string }
  | { readonly code: 'render.unverifiable'; readonly documentId: string }
  | {
      readonly code: 'render.diverged';
      readonly documentId: string;
      readonly recordedFrameHash: string;
      readonly renderedFrameHash: string;
    }
  | {
      readonly code: 'render.blocked';
      readonly documentId: string;
      /** Only the findings that block. The document's report carries the warnings beside them. */
      readonly findings: readonly ReadinessFinding[];
    };

export type RehearsalBlockerCode = RehearsalBlocker['code'];

/**
 * What became of one document.
 *
 * `slideIds` is the slides this document actually put through the renderer, which is how "every slide
 * was rehearsed" is a fact somebody can check rather than a count to trust. It is empty when the
 * document never reached the renderer at all.
 *
 * `findings` is the renderer's own verdict on those slides, carried through untouched — warnings
 * included, on a document that rehearsed perfectly well.
 */
export interface RehearsedDocument {
  readonly documentId: string;
  readonly state: 'rehearsed' | 'failed';
  readonly slideIds: readonly string[];
  /** The digest rehearsing produced, when rehearsing got far enough to produce one. */
  readonly frameHash?: string;
  readonly findings: readonly ReadinessFinding[];
  /** Present exactly when `state` is `failed`. */
  readonly blocker?: RehearsalBlocker;
}

/**
 * What the rehearsal came to. `kind` is `rehearsed` only when every document in the snapshot rendered
 * and matched; there is no partial pass, because a service is either safe to take offline or it is not.
 */
export interface RehearsalReport {
  readonly kind: 'rehearsed' | 'blocked';
  readonly documents: readonly RehearsedDocument[];
  /** Every slide the renderer actually drew, in the order the snapshot lists them. */
  readonly rehearsedSlideIds: readonly string[];
  readonly blockers: readonly RehearsalBlocker[];
}

/**
 * The browser capabilities a rehearsal needs, and nothing more.
 *
 * `measurer` is the one that decides the answer. Text measurement is the only thing preparation cannot
 * do from the model alone, so it is the only thing an offline browser can get wrong — a font that never
 * reached this machine measures as its fallback, wraps a line the pinned face did not, and produces a
 * different frame. That is what the parity check below catches, and it only catches it because the
 * measurer is this browser's rather than a recorded table of numbers.
 */
export interface RehearsalClients {
  readonly cache: PreparationCacheLike;
  readonly subtle: PreparationSubtleLike;
  readonly measurer: TextMeasurer;
}

/**
 * The same administrative defaults and service overrides the online render resolved against.
 *
 * They are the caller's to supply because they are pinned beside the snapshot, not derived from it. A
 * rehearsal prepared against different ones is a different render and diverges — which is the parity
 * check doing its job rather than a hole in it.
 */
export interface RehearsalOptions {
  readonly defaults?: AdministrativeRenderDefaults;
  readonly service?: ServiceRenderOverrides;
  readonly stepPx?: number;
}

const nameOf = (error: unknown): string => (error instanceof Error ? error.name : 'Error');

/**
 * The cached bytes, read as the render model they were pinned as.
 *
 * The check is shallow on purpose: `prepareRenderModel` refuses everything deeper — a slide carrying its
 * own aspect ratio, a picture of no width, an image with a soundtrack — and reports it as `render.failed`
 * with the renderer's own error name. Restating those rules here would be a second validator to keep in
 * step with the first. What this one answers is the question the renderer cannot be asked: whether these
 * bytes are a render model at all.
 */
const renderModelOf = (bytes: PreparationBytes): RenderModelInput => {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (typeof parsed !== 'object' || parsed === null) throw new TypeError('the cached document is not an object');
  const { id, outputType, slides } = parsed as Partial<RenderModelInput>;
  if (typeof id !== 'string' || typeof outputType !== 'string' || !Array.isArray(slides)) {
    throw new TypeError('the cached document is not a render model');
  }
  return { id, outputType, slides };
};

const failedBefore = (documentId: string, blocker: RehearsalBlocker): RehearsedDocument => ({
  documentId,
  state: 'failed',
  slideIds: [],
  findings: [],
  blocker: Object.freeze(blocker),
});

const rendered = (
  documentId: string,
  frame: RenderFrame,
  frameHash: string,
  blocker?: RehearsalBlocker,
): RehearsedDocument => ({
  documentId,
  state: blocker === undefined ? 'rehearsed' : 'failed',
  slideIds: Object.freeze(frame.slides.map((slide) => slide.id)),
  frameHash,
  findings: frame.findings,
  ...(blocker === undefined ? {} : { blocker: Object.freeze(blocker) }),
});

const blockedReport = (blocker: RehearsalBlocker): RehearsalReport => ({
  kind: 'blocked',
  documents: Object.freeze([]),
  rehearsedSlideIds: Object.freeze([]),
  blockers: Object.freeze([Object.freeze(blocker)]),
});

/**
 * Rehearses one document: reads it back out of the cache, renders it, and grades what came out.
 *
 * The order is what keeps the answer honest. A document whose recorded digest cannot be read is refused
 * before a frame is rendered, for the reason OFFL-02 refuses to fetch an asset it could never verify:
 * rendering something no comparison can be made against proves nothing and reports nothing useful. Past
 * that, parity is checked before the renderer's own grade, because a frame that is not the frame the
 * snapshot was pinned from is a fact about this browser, and the grade is about the slide either way —
 * it is carried on the report regardless of which blocker stopped the document.
 */
async function rehearseDocument(
  document: RehearsalDocument,
  { cache, subtle, measurer }: RehearsalClients,
  options: RehearsalOptions,
): Promise<RehearsedDocument> {
  const { id } = document;
  const recorded = recordedDigestOf(document.frameHash);
  if (recorded === undefined) return failedBefore(id, { code: 'document.frameHashUnknown', documentId: id });

  const bytes = await readCachedBytes(cache, document.url);
  if (bytes === undefined) return failedBefore(id, { code: 'document.notCached', documentId: id });

  let model: RenderModelInput;
  try {
    model = renderModelOf(bytes);
  } catch (error) {
    return failedBefore(id, { code: 'document.unreadable', documentId: id, reason: nameOf(error) });
  }

  let frame: RenderFrame;
  try {
    frame = renderPrepared(
      await prepareRenderModel({ model, measurer, defaults: options.defaults, service: options.service, stepPx: options.stepPx }),
    );
  } catch (error) {
    return failedBefore(id, { code: 'render.failed', documentId: id, reason: nameOf(error) });
  }

  // Copied into its own buffer because WebCrypto refuses a view that could be over a `SharedArrayBuffer`,
  // which is the same reason `PreparationBytes` is narrower than `Uint8Array`.
  const digest = await digestOf(subtle, new Uint8Array(frameBytes(frame)));
  if (digest === undefined) {
    return {
      documentId: id,
      state: 'failed',
      slideIds: Object.freeze(frame.slides.map((slide) => slide.id)),
      findings: frame.findings,
      blocker: Object.freeze({ code: 'render.unverifiable' as const, documentId: id }),
    };
  }

  const frameHash = `${FRAME_DIGEST_PREFIX}${digest}`;
  if (digest !== recorded) {
    return rendered(id, frame, frameHash, {
      code: 'render.diverged',
      documentId: id,
      recordedFrameHash: `${FRAME_DIGEST_PREFIX}${recorded}`,
      renderedFrameHash: frameHash,
    });
  }

  if (frame.readiness === 'blocked') {
    return rendered(id, frame, frameHash, {
      code: 'render.blocked',
      documentId: id,
      findings: Object.freeze(frame.findings.filter((found) => found.severity === 'blocker')),
    });
  }

  return rendered(id, frame, frameHash);
}

/**
 * Rehearses a pinned snapshot: renders every document in it out of the cache and compares the result
 * against the render it was pinned from.
 *
 * Completeness is the precondition, and it is `planPreparationCache`'s answer rather than a second
 * opinion — an entry is cached only when what the cache holds hashes to what the manifest pinned, which
 * is the same bar OFFL-02 caches to. A snapshot that is still missing bytes is blocked with them named
 * and nothing is rendered: a rehearsal of a half-cached service would pass or fail for reasons that have
 * nothing to do with rendering.
 *
 * Every document is rehearsed even after one of them fails, so an operator sees the whole repair at once
 * rather than rediscovering the next problem after each attempt. Nothing here writes to the cache, and
 * nothing here has anything to write with.
 */
export async function rehearsePreparation(
  snapshot: readonly PinnedEntry[],
  clients: RehearsalClients,
  options: RehearsalOptions = {},
): Promise<RehearsalReport> {
  const documents = snapshot.filter(isRehearsalDocument);
  // A snapshot nothing can be rendered out of has not been rehearsed, and a skipped rehearsal must never
  // read as a passed one: this is the vacuous pass invariant 7 would otherwise be satisfied by.
  if (documents.length === 0) return blockedReport({ code: 'snapshot.noDocuments' });

  const plan = await planPreparationCache(snapshot, clients);
  if (plan.pending.length > 0) {
    return blockedReport({
      code: 'cache.incomplete',
      pendingAssetIds: Object.freeze(plan.pending.map((entry) => entry.id)),
    });
  }

  const reports: RehearsedDocument[] = [];
  for (const document of documents) reports.push(await rehearseDocument(document, clients, options));

  const blockers = reports.flatMap((report) => (report.blocker === undefined ? [] : [report.blocker]));
  return {
    kind: blockers.length === 0 ? 'rehearsed' : 'blocked',
    documents: Object.freeze(reports),
    rehearsedSlideIds: Object.freeze(
      reports.flatMap((report) => (report.state === 'rehearsed' ? [...report.slideIds] : [])),
    ),
    blockers: Object.freeze(blockers),
  };
}
