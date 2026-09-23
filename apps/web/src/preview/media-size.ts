// The one place `ExactPreview`/`Thumbnail` learn a media asset's intrinsic size (P-29: cached per id, so
// switching slides or reopening the thumbnail never reloads a byte it already has). There is no
// client-facing route for media metadata by id, so this decodes the asset itself: a real `<img>` for an
// image, or a video's own poster derivative (itself an image) falling back to the video's own
// `loadedmetadata` when no poster is available.

import type { IntrinsicSize, MediaKind } from '@holydeck/renderer/render-model';

import { API } from '../api-routes.js';

function loadImage(src: string): Promise<IntrinsicSize> {
  return new Promise((resolve, reject) => {
    const element = document.createElement('img');
    element.addEventListener('load', () => resolve({ width: element.naturalWidth, height: element.naturalHeight }));
    element.addEventListener('error', () => reject(new Error(`could not load image: ${src}`)));
    element.src = src;
  });
}

function loadVideo(src: string): Promise<IntrinsicSize> {
  return new Promise((resolve, reject) => {
    const element = document.createElement('video');
    element.addEventListener('loadedmetadata', () => resolve({ width: element.videoWidth, height: element.videoHeight }));
    element.addEventListener('error', () => reject(new Error(`could not load video: ${src}`)));
    element.src = src;
  });
}

const cache = new Map<string, Promise<IntrinsicSize>>();

/** An image's own bytes give its size directly; a video's poster derivative stands in for one (posters
 *  are rendered at the video's own frame size), only decoding the video itself when there is no poster. */
export function intrinsicSizeOf(mediaId: string, kind: MediaKind): Promise<IntrinsicSize> {
  const key = `${kind}:${mediaId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const promise = kind === 'image'
    ? loadImage(API.mediaContent(mediaId))
    : loadImage(API.mediaDerivative(mediaId, 'poster')).catch(() => loadVideo(API.mediaContent(mediaId)));

  cache.set(key, promise);
  // A failed load is never cached — the id may still resolve once the underlying asset is fixed/retried.
  promise.catch(() => cache.delete(key));
  return promise;
}
