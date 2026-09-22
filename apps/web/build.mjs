import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

import browserslist from 'browserslist';
import { build, context } from 'esbuild';

import { BUILD_STAMP, buildStampText } from './src/build-stamp.ts';
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

const options = {
  define: { __HOLYDECK_BUILD_ID__: JSON.stringify(buildId) },
  entryPoints: ['src/main.ts', 'src/service-worker.ts'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target,
  sourcemap: true,
  minify: true,
  logLevel: 'warning',
};

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
        await finish(result.errors);
      });
    },
  };
  const watcher = await context({ ...options, plugins: [stamping] });
  await watcher.watch();
  process.stdout.write('watching apps/web for changes\n');
} else {
  const errors = await build(options).then(
    () => [],
    (error) => error.errors ?? [{ text: error.message }],
  );
  // The stamp is written either way; the exit code is what a one-shot build is asked for.
  if ((await finish(errors)) !== undefined) process.exit(1);
}
