// No font file ever ships: the client relies on the faces the device already has (LANG-02). `src/static/`
// is the only asset tree the build copies, so it is checked on every run; `dist/` is checked too whenever
// a build exists — the gate tests before it builds, so that half only runs after a local build.

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FONT_FILE = /\.(woff2?|ttf|otf)$/i;

function fontFilesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && FONT_FILE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const staticDirectory = fileURLToPath(new URL('./static/', import.meta.url));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));

describe('shipped fonts', () => {
  it('the static assets hold no font file', () => {
    expect(fontFilesIn(staticDirectory)).toEqual([]);
  });

  it.skipIf(!existsSync(dist))('the built client holds no font file', () => {
    expect(fontFilesIn(dist)).toEqual([]);
  });
});
