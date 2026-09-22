import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderShell } from './shell.js';

it('provides workspace navigation to distinct, named, focusable panels', () => {
  const html = readFileSync(new URL('./static/index.html', import.meta.url), 'utf8');
  const navigation = /<nav class="workspace-tabs"[^>]*>([\s\S]*?)<\/nav>/u.exec(html)?.[1] ?? '';
  const targets = [...navigation.matchAll(/href="#([^"]+)"/gu)].map((match) => match[1]);
  expect(targets).toEqual(['order', 'editor-preview', 'library', 'properties']);
  for (const id of targets) {
    const panels = [...html.matchAll(new RegExp(`<section[^>]* id="${id}"[^>]*>`, 'gu'))];
    expect(panels).toHaveLength(1);
    const tag = panels[0]?.[0] ?? '';
    expect(tag).toContain('class="workspace-panel"');
    expect(tag).toContain('tabindex="-1"');
    const heading = /aria-labelledby="([^"]+)"/u.exec(tag)?.[1];
    expect(heading).toBeDefined();
    expect(html).toContain(`id="${heading}"`);
  }
});

const documentWith = (statusPresent = true) => {
  const status = { textContent: 'Preparing the service view.' as string | null };
  const documentElement = { lang: 'en' };
  return {
    documentElement,
    status,
    getElementById: (id: string) => (id === 'status' && statusPresent ? status : null),
  };
};

describe('rendering the shell in the locale the device asks for', () => {
  it('replaces the served English with the copy of the language the device prefers', () => {
    const doc = documentWith();
    expect(renderShell(doc, ['de-CH', 'en'])).toBe('de');
    expect(doc.documentElement.lang).toBe('de');
    expect(doc.status.textContent).toBe('Die Gottesdienstansicht wird vorbereitet.');
  });

  it('renders Tamil, which is the locale no platform default would have picked', () => {
    const doc = documentWith();
    expect(renderShell(doc, ['ta-LK'])).toBe('ta');
    expect(doc.documentElement.lang).toBe('ta');
    expect(doc.status.textContent).toBe('வழிபாட்டுக் காட்சி தயாராகிறது.');
  });

  it('stays in English when the device speaks nothing this product does', () => {
    const doc = documentWith();
    expect(renderShell(doc, ['fr', 'it'])).toBe('en');
    expect(doc.documentElement.lang).toBe('en');
    expect(doc.status.textContent).toBe('Preparing the service view.');
  });

  // The language attribute is what a screen reader picks its voice from, so it is set whether or not
  // the element carrying the status line is there to write into.
  it('still says which language the document is in when the status line is absent', () => {
    const doc = documentWith(false);
    expect(renderShell(doc, ['ta'])).toBe('ta');
    expect(doc.documentElement.lang).toBe('ta');
    expect(doc.status.textContent).toBe('Preparing the service view.');
  });
});
