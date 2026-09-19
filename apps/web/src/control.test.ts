import { describe, expect, it } from 'vitest';

import { LOCALES } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

import { renderControl } from './control.js';

import type { ControlDocumentLike, ElementLike } from './control.js';
import type { OrderItem } from './control-state.js';
import type { SlideLabelEntry } from '@holydeck/contracts/slide-labels';

type FakeElement = ElementLike & { children: FakeElement[] };

const fakeElement = (): FakeElement => ({
  textContent: null,
  hidden: false,
  disabled: false,
  onclick: null,
  children: [],
  appendChild(child: ElementLike) {
    this.children.push(child as FakeElement);
  },
  replaceChildren(...nodes: readonly ElementLike[]) {
    this.children = nodes as FakeElement[];
  },
});

// Every id `control.ts` looks up, named once so a fake document and a "missing element" test can both
// build on the same list rather than drifting from `index.html` independently.
const REQUIRED_IDS = [
  'skip-links-heading',
  'skip-order',
  'skip-editor-preview',
  'skip-properties',
  'skip-live-controls',
  'order-heading',
  'order-empty',
  'order-list',
  'editor-preview-heading',
  'editor-heading',
  'editor-body',
  'preview-heading',
  'preview-empty',
  'preview-row',
  'preview-current-label',
  'preview-current',
  'preview-next-label',
  'preview-next',
  'properties-heading',
  'properties-empty',
  'properties-row',
  'properties-label-heading',
  'properties-value',
  'live-controls-heading',
  'live-previous',
  'live-next',
  'live-status',
] as const;

interface FakeDocument extends ControlDocumentLike {
  readonly elements: ReadonlyMap<string, FakeElement>;
  keydown?: (event: { readonly key: string }) => void;
}

const fakeDocument = (omit: readonly string[] = []): FakeDocument => {
  const elements = new Map<string, FakeElement>(
    REQUIRED_IDS.filter((id) => !omit.includes(id)).map((id) => [id, fakeElement()]),
  );
  const doc: FakeDocument = {
    elements,
    keydown: undefined,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: () => fakeElement(),
    addEventListener: (_type, listener) => {
      doc.keydown = listener;
    },
  };
  return doc;
};

const el = (doc: FakeDocument, id: (typeof REQUIRED_IDS)[number]): FakeElement => {
  const element = doc.elements.get(id);
  if (element === undefined) throw new Error(`test setup is missing #${id}`);
  return element;
};

const items: readonly OrderItem[] = [
  { id: 'a', label: 'Welcome' },
  { id: 'b', label: 'Call to Worship' },
  { id: 'c', label: 'Offering' },
];

const entry = (name: string, shortcut: '1' | '2' | '3'): SlideLabelEntry => ({ id: `label-${name}`, name, shortcut });

describe('rendering an empty order', () => {
  it('shows every region honestly empty, and disables the live transport', () => {
    const doc = fakeDocument();
    renderControl(doc, 'en', { items: [], catalogue: [] });

    expect(el(doc, 'order-empty').hidden).toBe(false);
    expect(el(doc, 'order-list').hidden).toBe(true);
    expect(el(doc, 'order-list').children).toEqual([]);
    expect(el(doc, 'preview-empty').hidden).toBe(false);
    expect(el(doc, 'preview-row').hidden).toBe(true);
    expect(el(doc, 'properties-empty').hidden).toBe(false);
    expect(el(doc, 'properties-row').hidden).toBe(true);
    expect(el(doc, 'editor-body').textContent).toBe(translate('en', 'control.editor.empty'));
    expect(el(doc, 'live-status').textContent).toBe('');
    expect(el(doc, 'live-previous').disabled).toBe(true);
    expect(el(doc, 'live-next').disabled).toBe(true);
  });
});

describe('localized static copy', () => {
  it.each(LOCALES)('renders the skip links and region headings in %s', (locale) => {
    const doc = fakeDocument();
    renderControl(doc, locale, { items: [], catalogue: [] });

    expect(el(doc, 'skip-links-heading').textContent).toBe(translate(locale, 'control.skipLinks.label'));
    expect(el(doc, 'skip-order').textContent).toBe(translate(locale, 'control.skip.order'));
    expect(el(doc, 'skip-editor-preview').textContent).toBe(translate(locale, 'control.skip.editorPreview'));
    expect(el(doc, 'skip-properties').textContent).toBe(translate(locale, 'control.skip.properties'));
    expect(el(doc, 'skip-live-controls').textContent).toBe(translate(locale, 'control.skip.liveControls'));
    expect(el(doc, 'order-heading').textContent).toBe(translate(locale, 'control.region.order'));
    expect(el(doc, 'editor-preview-heading').textContent).toBe(translate(locale, 'control.region.editorPreview'));
    expect(el(doc, 'properties-heading').textContent).toBe(translate(locale, 'control.region.properties'));
    expect(el(doc, 'live-controls-heading').textContent).toBe(translate(locale, 'control.region.liveControls'));
    expect(el(doc, 'live-previous').textContent).toBe(translate(locale, 'control.live.previous'));
    expect(el(doc, 'live-next').textContent).toBe(translate(locale, 'control.live.next'));
  });
});

describe('rendering a non-empty order', () => {
  it('lists every item and previews the first as current, its neighbour as next', () => {
    const doc = fakeDocument();
    renderControl(doc, 'en', { items, catalogue: [] });

    expect(el(doc, 'order-empty').hidden).toBe(true);
    expect(el(doc, 'order-list').hidden).toBe(false);
    expect(el(doc, 'order-list').children).toHaveLength(3);
    const rowButtons = el(doc, 'order-list').children.map((row) => row.children[0]);
    expect(rowButtons.map((button) => button?.textContent)).toEqual(
      items.map((item) => translate('en', 'control.order.select', { label: item.label })),
    );

    expect(el(doc, 'preview-current').textContent).toBe('Welcome');
    expect(el(doc, 'preview-next').textContent).toBe('Call to Worship');
    expect(el(doc, 'editor-body').textContent).toBe('Welcome');
    expect(el(doc, 'properties-value').textContent).toBe('Welcome');
    expect(el(doc, 'live-status').textContent).toBe(translate('en', 'control.status.showing', { label: 'Welcome' }));
    expect(el(doc, 'live-previous').disabled).toBe(true);
    expect(el(doc, 'live-next').disabled).toBe(false);
  });

  it('selects whichever item its own button was clicked for, and shows the last item with no next', () => {
    const doc = fakeDocument();
    renderControl(doc, 'en', { items, catalogue: [] });

    const lastButton = el(doc, 'order-list').children[2]?.children[0];
    lastButton?.onclick?.();

    expect(el(doc, 'preview-current').textContent).toBe('Offering');
    expect(el(doc, 'preview-next').textContent).toBe(translate('en', 'control.preview.noNext'));
    expect(el(doc, 'live-previous').disabled).toBe(false);
    expect(el(doc, 'live-next').disabled).toBe(true);
  });
});

describe('the live transport', () => {
  it('moves one position per click and clamps at both boundaries rather than wrapping', () => {
    const doc = fakeDocument();
    renderControl(doc, 'en', { items, catalogue: [] });

    el(doc, 'live-next').onclick?.();
    expect(el(doc, 'preview-current').textContent).toBe('Call to Worship');
    el(doc, 'live-next').onclick?.();
    expect(el(doc, 'preview-current').textContent).toBe('Offering');
    // One more Next past the last item is a no-op, not a wraparound to the first.
    el(doc, 'live-next').onclick?.();
    expect(el(doc, 'preview-current').textContent).toBe('Offering');

    el(doc, 'live-previous').onclick?.();
    el(doc, 'live-previous').onclick?.();
    expect(el(doc, 'preview-current').textContent).toBe('Welcome');
    // One more Previous before the first item is a no-op too.
    el(doc, 'live-previous').onclick?.();
    expect(el(doc, 'preview-current').textContent).toBe('Welcome');
  });
});

describe('the T52 shortcut catalogue in the live surface', () => {
  it('jumps to the position of the item bound to the key it is given', () => {
    const doc = fakeDocument();
    const catalogue = [entry('Call to Worship', '2'), entry('Offering', '3')];
    renderControl(doc, 'en', { items, catalogue });

    doc.keydown?.({ key: '2' });
    expect(el(doc, 'preview-current').textContent).toBe('Call to Worship');

    doc.keydown?.({ key: '3' });
    expect(el(doc, 'preview-current').textContent).toBe('Offering');
  });

  it('leaves the selection untouched for a key the catalogue never bound, and for one that is not a shortcut key at all', () => {
    const doc = fakeDocument();
    const catalogue = [entry('Offering', '3')];
    renderControl(doc, 'en', { items, catalogue });

    doc.keydown?.({ key: '3' });
    expect(el(doc, 'preview-current').textContent).toBe('Offering');

    doc.keydown?.({ key: '1' });
    expect(el(doc, 'preview-current').textContent).toBe('Offering');

    doc.keydown?.({ key: 'Enter' });
    expect(el(doc, 'preview-current').textContent).toBe('Offering');
  });
});

describe('a control surface missing one of its regions', () => {
  it('refuses to render silently against the wrong element rather than failing later with no explanation', () => {
    const doc = fakeDocument(['live-status']);
    expect(() => renderControl(doc, 'en', { items: [], catalogue: [] })).toThrow(/live-status/);
  });
});
