export interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

export interface WebManifest {
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  lang: string;
  dir: string;
  icons: ManifestIcon[];
}

const INSTALLABLE_DISPLAYS = ['standalone', 'fullscreen', 'minimal-ui'];

export const WEB_MANIFEST: WebManifest = {
  name: 'HolyDeck',
  short_name: 'HolyDeck',
  description: 'Prepare and present a service: bible verses, songs and media, on the stage display.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0b0b0f',
  theme_color: '#0b0b0f',
  lang: 'en',
  dir: 'ltr',
  // Provisional placeholder artwork: flat fill, no wordmark. See src/static/icons/README.md.
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
};

/** The checks a browser runs before it offers to install. Reported together, never one at a time. */
export function installabilityProblems(manifest: WebManifest): string[] {
  const problems: string[] = [];
  if (manifest.name.trim() === '') problems.push('name: must not be empty');
  if (manifest.short_name.trim() === '') problems.push('short_name: must not be empty');
  if (!manifest.start_url.startsWith('/')) {
    problems.push(`start_url: must be origin-relative, got ${JSON.stringify(manifest.start_url)}`);
  }
  if (!INSTALLABLE_DISPLAYS.includes(manifest.display)) {
    problems.push(
      `display: must be standalone, fullscreen or minimal-ui, got ${JSON.stringify(manifest.display)}`,
    );
  }
  for (const size of ['192x192', '512x512']) {
    if (!manifest.icons.some((icon) => icon.sizes === size)) {
      problems.push(`icons: must include a ${size} icon`);
    }
  }
  return problems;
}
