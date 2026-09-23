import type { MediaStorageIO } from '../../src/media.js';

export interface FakeMediaStorageIO extends MediaStorageIO {
  readonly writes: Array<{ root: string; key: string; bytes: Uint8Array }>;
  readonly removed: string[];
}

/** In-memory media storage for asserting writes without touching a deployment's media root. */
export function fakeMediaStorageIO(): FakeMediaStorageIO {
  const writes: Array<{ root: string; key: string; bytes: Uint8Array }> = [];
  const removed: string[] = [];
  return {
    writes,
    removed,
    async write(root, key, bytes) {
      writes.push({ root, key, bytes });
      return `${root}/${key}`;
    },
    async read(_root, key) {
      const found = writes.find((write) => `${write.root}/${write.key}` === key);
      if (found === undefined) throw new Error(`${key} was not stored`);
      return found.bytes;
    },
    async remove(_root, key) {
      removed.push(key);
    },
  };
}
