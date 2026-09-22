// What the build is allowed to ship, and which of its files the service worker has to hold.
//
// The client is split (roadmap D2): one entry every surface loads, and chunks esbuild cuts out of it
// for code only some routes reach — an output window never loads editor code. Two questions follow
// from that, both answered here rather than inside `build.mjs` so they can be graded without building:
// how large the entry may grow before a phone on a church's guest network waits too long for the first
// screen, and which chunk files an offline device needs cached before it loses the network.

/** The entry chunk's ceiling, compressed the way it travels. The spec's figure, not a measured one. */
export const ENTRY_BUDGET_BYTES = 60 * 1024;

/** Where esbuild writes the chunks it splits out, relative to the build directory. */
export const CHUNK_DIRECTORY = 'chunks/';

/** Why the entry is too large to ship, or nothing when it fits. */
export function entryBudgetProblem(gzipBytes: number): string | undefined {
  if (gzipBytes <= ENTRY_BUDGET_BYTES) return undefined;
  return `main.js is ${kilobytes(gzipBytes)} gzip, over the ${kilobytes(ENTRY_BUDGET_BYTES)} entry budget`;
}

/** A size the build log can say out loud, to one decimal place. */
export const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * The chunk files a build produced, as the paths a browser asks for them at. Read from the output
 * list of esbuild's metafile (`dist/chunks/x-HASH.js`), so a chunk the build did not write cannot be
 * named here and a chunk it did write cannot be forgotten. Source maps are left out: an offline
 * device presents a service, it does not debug one.
 */
export function precacheChunks(outputs: readonly string[], outdir = 'dist/'): readonly string[] {
  const prefix = `${outdir}${CHUNK_DIRECTORY}`;
  return outputs
    .filter((path) => path.startsWith(prefix) && path.endsWith('.js'))
    .map((path) => `/${path.slice(outdir.length)}`)
    .sort();
}
