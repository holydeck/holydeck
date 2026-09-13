import { describe, expect, it } from 'vitest';

import { WEB_MANIFEST, installabilityProblems } from './manifest.js';

describe('the web app manifest', () => {
  it('meets every installability requirement a browser checks', () => {
    expect(installabilityProblems(WEB_MANIFEST)).toEqual([]);
  });

  it('is served from the origin root, so one install covers the whole client', () => {
    expect(WEB_MANIFEST.start_url).toBe('/');
    expect(WEB_MANIFEST.scope).toBe('/');
    expect(WEB_MANIFEST.display).toBe('standalone');
  });

  it('offers a maskable icon, so the installed icon is not letterboxed', () => {
    expect(WEB_MANIFEST.icons.some((icon) => icon.purpose.includes('maskable'))).toBe(true);
  });

  it('rejects a manifest that cannot be launched from the installed icon', () => {
    expect(
      installabilityProblems({ ...WEB_MANIFEST, short_name: ' ', start_url: 'https://example.test/' }),
    ).toEqual([
      'short_name: must not be empty',
      'start_url: must be origin-relative, got "https://example.test/"',
    ]);
  });

  it('names what is missing instead of shipping an uninstallable manifest', () => {
    const problems = installabilityProblems({
      ...WEB_MANIFEST,
      name: '',
      display: 'browser',
      icons: WEB_MANIFEST.icons.filter((icon) => icon.sizes !== '512x512'),
    });

    expect(problems).toEqual([
      'name: must not be empty',
      'display: must be standalone, fullscreen or minimal-ui, got "browser"',
      'icons: must include a 512x512 icon',
    ]);
  });
});
