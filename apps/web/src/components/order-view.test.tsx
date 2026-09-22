// @vitest-environment happy-dom
// The workspace is exercised as an operator reaches it: its fixed landmarks and localized labels are
// rendered first, then clicks and key presses move the same selection that the live transport reports.

import { act, fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import { LOCALES } from '@holydeck/localization/locales';
import { translate } from '@holydeck/localization/messages';

import { locale, resetAppState } from '../app-state.js';
import { OrderView } from './order-view.js';

import type { ControlData } from './order-data.js';

const data: ControlData = {
  items: [
    { id: 'welcome', label: 'Welcome' },
    { id: 'call', label: 'Call to Worship' },
    { id: 'offering', label: 'Offering' },
  ],
  catalogue: [
    { id: 'call-label', name: 'Call to Worship', shortcut: '2' },
    { id: 'offering-label', name: 'Offering', shortcut: '3' },
  ],
};

const empty: ControlData = { items: [], catalogue: [] };

describe('OrderView', () => {
  beforeEach(() => {
    resetAppState();
  });

  it('renders every workspace target, service heading and empty-state boundary honestly', () => {
    render(<OrderView data={empty} serviceId="sunday" />);

    expect(screen.getByRole('heading', { level: 1, name: 'Service sunday' }).className).toBe('visually-hidden');
    expect(screen.getByText('sunday').className).toBe('service-id');
    for (const id of ['order', 'editor-preview', 'properties', 'library', 'live-controls']) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(document.getElementById('order-empty')?.hidden).toBe(false);
    expect(document.getElementById('order-list')?.hidden).toBe(true);
    expect(document.getElementById('preview-empty')?.hidden).toBe(false);
    expect(document.getElementById('preview-row')?.hidden).toBe(true);
    expect(document.getElementById('properties-empty')?.hidden).toBe(false);
    expect(document.getElementById('properties-row')?.hidden).toBe(true);
    expect(document.getElementById('editor-body')?.textContent).toBe(translate('en', 'control.editor.empty'));
    expect(document.getElementById('live-status')?.textContent).toBe('');
    expect((document.getElementById('live-previous') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('live-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(LOCALES)('renders every fixed workspace label in %s', (value) => {
    act(() => {
      locale.value = value;
    });
    render(<OrderView data={empty} serviceId="sunday" />);

    expect(document.getElementById('skip-links-heading')?.textContent).toBe(translate(value, 'control.skipLinks.label'));
    expect(document.getElementById('order-heading')?.textContent).toBe(translate(value, 'control.region.order'));
    expect(document.getElementById('editor-preview-heading')?.textContent).toBe(translate(value, 'control.region.editorPreview'));
    expect(document.getElementById('properties-heading')?.textContent).toBe(translate(value, 'control.region.properties'));
    expect(document.getElementById('library-heading')?.textContent).toBe(translate(value, 'control.region.library'));
    expect(document.getElementById('live-controls-heading')?.textContent).toBe(translate(value, 'control.region.liveControls'));
    expect(screen.getByRole('navigation', { name: translate(value, 'control.tabs.label') })).toBeTruthy();
    expect(document.getElementById('live-previous')?.textContent).toBe(translate(value, 'control.live.previous'));
    expect(document.getElementById('live-next')?.textContent).toBe(translate(value, 'control.live.next'));
  });

  it('lists the order, previews its first item and lets an item button select the last', () => {
    render(<OrderView data={data} serviceId="sunday" />);

    expect(document.getElementById('order-list')?.hidden).toBe(false);
    expect(screen.getAllByRole('button', { name: /Show/u })).toHaveLength(3);
    expect(document.getElementById('preview-current')?.textContent).toBe('Welcome');
    expect(document.getElementById('preview-next')?.textContent).toBe('Call to Worship');
    expect(document.getElementById('editor-body')?.textContent).toBe('Welcome');
    expect(document.getElementById('properties-value')?.textContent).toBe('Welcome');
    expect(document.getElementById('live-status')?.textContent).toBe('Now showing Welcome.');

    fireEvent.click(screen.getByRole('button', { name: 'Show Offering' }));
    expect(document.getElementById('preview-current')?.textContent).toBe('Offering');
    expect(document.getElementById('preview-next')?.textContent).toBe(translate('en', 'control.preview.noNext'));
    expect((document.getElementById('live-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('moves one position per transport click and clamps at both boundaries', () => {
    render(<OrderView data={data} serviceId="sunday" />);
    const previous = screen.getByRole('button', { name: 'Previous slide' });
    const next = screen.getByRole('button', { name: 'Next slide' });

    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(document.getElementById('preview-current')?.textContent).toBe('Offering');
    fireEvent.click(previous);
    fireEvent.click(previous);
    fireEvent.click(previous);
    expect(document.getElementById('preview-current')?.textContent).toBe('Welcome');
  });

  it('jumps through its catalogue shortcuts and ignores every unbound key', () => {
    render(<OrderView data={data} serviceId="sunday" />);

    fireEvent.keyDown(document, { key: '2' });
    expect(document.getElementById('preview-current')?.textContent).toBe('Call to Worship');
    fireEvent.keyDown(document, { key: '3' });
    expect(document.getElementById('preview-current')?.textContent).toBe('Offering');
    fireEvent.keyDown(document, { key: '1' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(document.getElementById('preview-current')?.textContent).toBe('Offering');
  });
});
