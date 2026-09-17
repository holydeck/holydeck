import { createHash } from 'node:crypto';

import { sniffMediaType } from '@holydeck/contracts/media';

import type { MediaDerivative } from '@holydeck/contracts/media';
import type { MediaLibrary, MediaStorageIO } from '@holydeck/app/media';
import type { Handler } from './runner.js';

export interface PosterGenerator {
  generate(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array | undefined>;
}

export interface MediaIngestOptions {
  readonly context: unknown;
  readonly media: MediaLibrary;
  readonly storage: MediaStorageIO;
  readonly mediaRoot: string;
  readonly poster: PosterGenerator;
}

const HASH = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const stopped = (signal: AbortSignal): void => {
  if (signal.aborted) throw new Error('media ingestion stopped after its lease was lost');
};

const assetIdOf = (payload: unknown): string => {
  const assetId = (payload as { assetId?: unknown }).assetId;
  if (typeof assetId !== 'string' || assetId === '') throw new Error('a media-ingest job needs a non-empty payload.assetId');
  return assetId;
};

const identityOf = (assetId: string, bytes: Uint8Array): MediaDerivative => ({
  kind: 'source',
  bytes: bytes.byteLength,
  hash: HASH(bytes),
  from: assetId,
});

/** Turns one sniffed upload into its source-preserving derivative and, for video, one static poster. */
export function mediaIngestOn(options: MediaIngestOptions): Handler {
  return async (job, signal) => {
    const assetId = assetIdOf(job.payload);
    const current = await options.media.inspect(options.context, assetId);
    if (current === undefined) throw new Error(`media asset ${assetId} does not exist`);
    if (current.manifest.processingState === 'failed' && job.attempt === 1) {
      await options.media.retryProcessing(options.context, assetId);
    }

    const processing = await options.media.startProcessing(options.context, assetId);
    if (processing === undefined) throw new Error(`media asset ${assetId} does not exist`);
    if (processing.manifest.processingState === 'ready') return;

    try {
      const source = await options.storage.read(options.mediaRoot, processing.storageKey);
      stopped(signal);
      const type = sniffMediaType(source);
      if (type !== processing.manifest.type) {
        throw new Error(`media asset ${assetId} no longer matches its sniffed type`);
      }

      const identity = identityOf(assetId, source);
      if (identity.hash !== processing.manifest.hash) {
        throw new Error(`media asset ${assetId} was not preserved unchanged: stored bytes no longer match its recorded hash`);
      }

      const derivatives: MediaDerivative[] = [identity];
      if (type === 'video/mp4') {
        const poster = await options.poster.generate(source, signal);
        stopped(signal);
        if (poster === undefined) throw new Error(`media asset ${assetId} has no static poster frame`);
        await options.storage.write(options.mediaRoot, `${assetId}.poster.jpg`, poster);
        stopped(signal);
        derivatives.push({ kind: 'poster', bytes: poster.byteLength, hash: HASH(poster), from: assetId });
      }
      await options.media.completeProcessing(options.context, assetId, derivatives);
    } catch (error) {
      // A lost lease normally means a legitimate next attempt is coming, so the manifest is left in
      // `processing` for it to find. The exhausted attempt is the one exception: once `attempt` has
      // reached `retryLimit`, the queue's own claim never hands this job to anyone again (`claimUpdate`
      // retires a leased-and-exhausted job to `failed` without granting a new attempt), so there is no
      // future writer this write could race — recording `failed` here is safe whether or not the lease
      // is still nominally held, and it is the only thing that ever moves the manifest out of `processing`
      // for a job the queue will not run again.
      if (job.attempt >= job.retryLimit) {
        await options.media.failProcessing(options.context, assetId);
      }
      throw error;
    }
  };
}
