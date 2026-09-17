import type { MediaStorageIO } from '../../src/media.js';

export interface FakeMediaStorageIO extends MediaStorageIO {
  readonly writes: Array<{ root: string; key: string; bytes: Uint8Array }>;
}

/** In-memory media storage for asserting writes without touching a deployment's media root. */
export function fakeMediaStorageIO(): FakeMediaStorageIO {
  const writes: Array<{ root: string; key: string; bytes: Uint8Array }> = [];
  return {
    writes,
    async write(root, key, bytes) {
      writes.push({ root, key, bytes });
      return `${root}/${key}`;
    },
  };
}
