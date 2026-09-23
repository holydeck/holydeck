// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { API } from '../api-routes.js';

import { intrinsicSizeOf } from './media-size.js';

function spyOnCreateElement(onCreate: (tag: string, element: HTMLElement) => void): void {
  const original = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
    const element = original(tag, options);
    onCreate(tag, element);
    return element;
  });
}

describe('intrinsicSizeOf', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads an image via API.mediaContent and reads its natural size', async () => {
    let img: HTMLImageElement | undefined;
    spyOnCreateElement((tag, element) => {
      if (tag === 'img') img = element as HTMLImageElement;
    });

    const promise = intrinsicSizeOf('img1', 'image');
    expect(img?.getAttribute('src')).toBe(API.mediaContent('img1'));
    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
    img?.dispatchEvent(new Event('load'));

    await expect(promise).resolves.toEqual({ width: 800, height: 600 });
  });

  it('rejects when the image fails to load', async () => {
    let img: HTMLImageElement | undefined;
    spyOnCreateElement((tag, element) => {
      if (tag === 'img') img = element as HTMLImageElement;
    });

    const promise = intrinsicSizeOf('missing', 'image');
    img?.dispatchEvent(new Event('error'));

    await expect(promise).rejects.toThrow();
  });

  it('for a video, loads the poster derivative first', async () => {
    let img: HTMLImageElement | undefined;
    spyOnCreateElement((tag, element) => {
      if (tag === 'img') img = element as HTMLImageElement;
    });

    const promise = intrinsicSizeOf('vid1', 'video');
    expect(img?.getAttribute('src')).toBe(API.mediaDerivative('vid1', 'poster'));
    Object.defineProperty(img, 'naturalWidth', { value: 1280, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 720, configurable: true });
    img?.dispatchEvent(new Event('load'));

    await expect(promise).resolves.toEqual({ width: 1280, height: 720 });
  });

  it('falls back to the video element loadedmetadata when the poster fails', async () => {
    let img: HTMLImageElement | undefined;
    let video: HTMLVideoElement | undefined;
    spyOnCreateElement((tag, element) => {
      if (tag === 'img') img = element as HTMLImageElement;
      if (tag === 'video') video = element as HTMLVideoElement;
    });

    const promise = intrinsicSizeOf('vid2', 'video');
    img?.dispatchEvent(new Event('error'));
    await Promise.resolve();
    await Promise.resolve();

    expect(video?.getAttribute('src')).toBe(API.mediaContent('vid2'));
    Object.defineProperty(video, 'videoWidth', { value: 1920, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 1080, configurable: true });
    video?.dispatchEvent(new Event('loadedmetadata'));

    await expect(promise).resolves.toEqual({ width: 1920, height: 1080 });
  });

  it('caches per media id and kind, never creating a second element for the same request', async () => {
    const created: HTMLImageElement[] = [];
    spyOnCreateElement((tag, element) => {
      if (tag === 'img') created.push(element as HTMLImageElement);
    });

    const first = intrinsicSizeOf('cached-1', 'image');
    Object.defineProperty(created[0], 'naturalWidth', { value: 100, configurable: true });
    Object.defineProperty(created[0], 'naturalHeight', { value: 50, configurable: true });
    created[0]?.dispatchEvent(new Event('load'));
    await first;

    const second = intrinsicSizeOf('cached-1', 'image');
    await expect(second).resolves.toEqual({ width: 100, height: 50 });
    expect(created).toHaveLength(1);
  });

  it('does not cache a failed load, so a later call retries', async () => {
    const created: HTMLImageElement[] = [];
    spyOnCreateElement((tag, element) => {
      if (tag === 'img') created.push(element as HTMLImageElement);
    });

    const first = intrinsicSizeOf('retry-1', 'image');
    created[0]?.dispatchEvent(new Event('error'));
    await expect(first).rejects.toThrow();

    const second = intrinsicSizeOf('retry-1', 'image');
    Object.defineProperty(created[1], 'naturalWidth', { value: 10, configurable: true });
    Object.defineProperty(created[1], 'naturalHeight', { value: 20, configurable: true });
    created[1]?.dispatchEvent(new Event('load'));

    await expect(second).resolves.toEqual({ width: 10, height: 20 });
    expect(created).toHaveLength(2);
  });
});
