import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import browserslist from 'browserslist';
import { build } from 'esbuild';

import { WEB_MANIFEST, installabilityProblems } from './src/manifest.ts';
import { esbuildTargets } from './src/targets.ts';

const root = new URL('../../', import.meta.url);
const dist = new URL('dist/', import.meta.url);

const queries = (await readFile(new URL('.browserslistrc', root), 'utf8'))
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

const target = esbuildTargets(browserslist(queries));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: ['src/main.ts', 'src/service-worker.ts'],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target,
  sourcemap: true,
  minify: true,
  logLevel: 'warning',
});

await cp(new URL('src/static/', import.meta.url), dist, { recursive: true });
await rm(new URL('icons/README.md', dist));

const problems = installabilityProblems(WEB_MANIFEST);
// Shipping a manifest a browser will not install is a release nobody can install; fail the build.
if (problems.length > 0) throw new Error(`the manifest is not installable:\n  ${problems.join('\n  ')}`);
await writeFile(new URL('manifest.webmanifest', dist), `${JSON.stringify(WEB_MANIFEST, null, 2)}\n`);

const shell = await readFile(new URL('index.html', dist), 'utf8');
for (const required of ['/manifest.webmanifest', '/main.js', '/app.css', WEB_MANIFEST.theme_color]) {
  if (!shell.includes(required)) throw new Error(`index.html does not reference ${required}`);
}

process.stdout.write(`web built for ${target.join(', ')}\n`);
