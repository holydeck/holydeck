import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

import browserslist from 'browserslist';
import { build, context } from 'esbuild';

import { BUILD_STAMP, buildStampText } from './src/build-stamp.ts';
import { entryBudgetProblem, kilobytes, precacheChunks } from './src/bundle-budget.ts';
import { WEB_MANIFEST, installabilityProblems } from './src/manifest.ts';
import { esbuildTargets } from './src/targets.ts';

// `--watch` is the development stack's mode: it rebuilds on every edit and keeps running through a
// compile error, so the build records whether it worked in dist/build.json instead of only exiting.
const watching = process.argv.includes('--watch');

const root = new URL('../../', import.meta.url);
const dist = new URL('dist/', import.meta.url);

const queries = (await readFile(new URL('.browserslistrc', root), 'utf8'))
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

const target = esbuildTargets(browserslist(queries));

const buildId = Date.now().toString(36);

// Emptied rather than removed: in the development stack this directory is a mount the application
// reads the client from, and a mount point cannot be unlinked from inside the container.
await mkdir(dist, { recursive: true });
for (const entry of await readdir(dist)) await rm(new URL(entry, dist), { recursive: true, force: true });

const shared = {
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target,
  sourcemap: true,
  minify: true,
  logLevel: 'warning',
};

// The client itself: TSX through Preact's automatic runtime (roadmap D1), split so a route that is
// loaded lazily lands in its own chunk under chunks/ and never in the entry every surface pays for.
const client = {
  ...shared,
  define: { __HOLYDECK_BUILD_ID__: JSON.stringify(buildId) },
  entryPoints: ['src/main.tsx'],
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  metafile: true,
};

// The service worker is its own build and is never split: a worker script that imports a chunk would
// need that chunk before it could install, which is the one moment nothing is cached yet. It is built
// after the client because what it precaches is whatever chunks that build just wrote.
const worker = (chunks) => ({
  ...shared,
  define: { __HOLYDECK_BUILD_ID__: JSON.stringify(buildId), __HOLYDECK_PRECACHE__: JSON.stringify(chunks) },
  entryPoints: ['src/service-worker.ts'],
});

/** Builds the worker against the client build's own output list. */
const buildWorker = (metafile) => build(worker(precacheChunks(Object.keys(metafile?.outputs ?? {}))));

/** Everything around the bundle, including the checks that refuse a client nobody could install. */
async function assemble() {
  await cp(new URL('src/static/', import.meta.url), dist, { recursive: true });
  await rm(new URL('icons/README.md', dist), { force: true });

  const problems = installabilityProblems(WEB_MANIFEST);
  if (problems.length > 0) throw new Error(`the manifest is not installable:\n  ${problems.join('\n  ')}`);
  await writeFile(new URL('manifest.webmanifest', dist), `${JSON.stringify(WEB_MANIFEST, null, 2)}\n`);

  const shell = await readFile(new URL('index.html', dist), 'utf8');
  for (const required of ['/manifest.webmanifest', '/main.js', '/app.css', WEB_MANIFEST.theme_color]) {
    if (!shell.includes(required)) throw new Error(`index.html does not reference ${required}`);
  }

  // Measured compressed, because that is how it crosses the network, and said every build so a
  // growing entry is seen long before it is refused.
  const entry = gzipSync(await readFile(new URL('main.js', dist))).length;
  process.stdout.write(`main.js is ${kilobytes(entry)} gzip\n`);
  const overBudget = entryBudgetProblem(entry);
  if (overBudget !== undefined) throw new Error(overBudget);
}

/** Runs after every build, watching or not, and returns why it failed or nothing. */
async function finish(errors) {
  const failed = errors.length > 0 ? errors.map((error) => error.text).join('; ') : undefined;
  const problem = failed ?? (await assemble().then(() => undefined, (error) => error.message));
  await writeFile(
    new URL(BUILD_STAMP, dist),
    buildStampText({ at: new Date().toISOString(), ok: problem === undefined, target, problem }),
  );
  process.stdout.write(problem === undefined ? `web built for ${target.join(', ')}\n` : `web build failed: ${problem}\n`);
  return problem;
}

if (watching) {
  const stamping = {
    name: 'build-stamp',
    setup(builder) {
      builder.onEnd(async (result) => {
        const errors = result.errors.length > 0
          ? result.errors
          : await buildWorker(result.metafile).then(() => [], (error) => error.errors ?? [{ text: error.message }]);
        await finish(errors);
      });
    },
  };
  const watcher = await context({ ...client, plugins: [stamping] });
  await watcher.watch();
  process.stdout.write('watching apps/web for changes\n');
} else {
  const errors = await build(client).then(
    (result) => buildWorker(result.metafile).then(() => []),
  ).catch((error) => error.errors ?? [{ text: error.message }]);
  // The stamp is written either way; the exit code is what a one-shot build is asked for.
  if ((await finish(errors)) !== undefined) process.exit(1);
}
