// Browserslist names engines its own way and esbuild names them another; this is the one place that
// translation lives, so lowering a target in .browserslistrc lowers what the bundle downlevels for.
const ESBUILD_ENGINES: Record<string, string> = {
  chrome: 'chrome',
  and_chr: 'chrome',
  android: 'chrome',
  ios_saf: 'ios',
  safari: 'safari',
  edge: 'edge',
  firefox: 'firefox',
  and_ff: 'firefox',
};

const compareVersions = (left: string, right: string): number => {
  const parts = (version: string): number[] => version.split('.').map(Number);
  const [a, b] = [parts(left), parts(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export function esbuildTargets(queries: readonly string[]): string[] {
  const oldest = new Map<string, string>();
  for (const query of queries) {
    const [browser = '', versions = ''] = query.split(' ');
    const engine = ESBUILD_ENGINES[browser];
    // Dropping an engine esbuild cannot express would ship untranspiled syntax to a device the
    // project promised to support, and nothing would say so.
    if (engine === undefined) throw new Error(`no esbuild target for ${browser}`);
    // A range such as "26.4-26.6" is one release train; the oldest member is what must still parse.
    const [version = ''] = versions.split('-');
    const current = oldest.get(engine);
    if (current === undefined || compareVersions(version, current) < 0) oldest.set(engine, version);
  }
  return [...oldest].map(([engine, version]) => `${engine}${version}`).sort();
}
