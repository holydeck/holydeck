// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import { successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';

import type { FetchLike } from '../api.js';
import type { ServiceView } from './service-data.js';

import { setFetching } from '../request.js';
import { drift, resetWorkspace, selection, service } from '../state/workspace-store.js';
import { outputDefaults } from './output-defaults.js';
import { PropertiesPanel } from './PropertiesPanel.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const noOutputDefaults: FetchLike = async () =>
  reply(200, successEnvelope({
    aspectRatio: '16:9',
    safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
    uploadLimitBytes: 1_073_741_824,
  }, 'r-defaults'));

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', sections: [],
  revision: '2026-09-27T10:00:00.000Z',
};

const itemA: ServiceItem = {
  id: 'a', kind: 'song', title: 'Song A', enabled: true, content: { id: 'c1', revision: 2, hash: undefined },
};

beforeEach(() => {
  resetWorkspace();
  outputDefaults.value = undefined;
  setFetching(noOutputDefaults);
});

describe('PropertiesPanel', () => {
  it('renders nothing before a service has loaded', () => {
    const { container } = render(<PropertiesPanel />);
    expect(container.textContent).toBe('');
  });

  it('shows the service summary as read-only text and the children after it', () => {
    service.value = view;
    render(<PropertiesPanel><p>Item properties</p></PropertiesPanel>);

    expect(screen.getByRole('heading', { name: 'Sunday' })).toBeTruthy();
    expect(screen.getByText('Main Hall')).toBeTruthy();
    expect(screen.getByText('Upcoming')).toBeTruthy();
    expect(screen.getByText('Item properties')).toBeTruthy();
  });

  it('shows the output profile only while no item is selected', () => {
    service.value = { ...view, sections: [{ id: 'sec', name: 'Welcome', items: [itemA] }] };
    const { rerender } = render(<PropertiesPanel />);
    expect(screen.queryByText('Output')).toBeTruthy();

    selection.value = { itemId: 'a' };
    rerender(<PropertiesPanel />);
    expect(screen.queryByText('Output')).toBeNull();
  });

  it('shows a read-only compare of both revisions once the selected item has drifted', async () => {
    const history = [
      { stamp: { id: 'c1' }, title: 'Song A', revision: 2, at: 'x', body: { sections: [{ label: 'Verse 1' }, { label: 'Chorus' }] } },
      { stamp: { id: 'c1' }, title: 'Song A (new)', revision: 5, at: 'y', body: { sections: [{ label: 'Verse 1' }, { label: 'Bridge' }] } },
    ];
    setFetching(async (url, init) => (String(url) === '/api/v1/songs/c1/history' ? reply(200, successEnvelope(history, 'r')) : noOutputDefaults(url, init)));
    service.value = { ...view, sections: [{ id: 'sec', name: 'Welcome', items: [itemA] }] };
    selection.value = { itemId: 'a' };
    drift.value = [{ itemId: 'a', latestRevision: 5 }];
    render(<PropertiesPanel />);

    expect(screen.getByText('Reading both revisions…')).toBeTruthy();
    expect(await screen.findByRole('columnheader', { name: 'Pinned revision 2' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Latest revision 5' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Song A' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Song A (new)' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Verse 1, Chorus' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'Verse 1, Bridge' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update to revision 5' })).toBeTruthy();
  });

  it('says so when the history cannot be read, and offers no compare for kinds without one', async () => {
    setFetching(async (url, init) => (String(url).endsWith('/history') ? reply(404, { error: { code: 'not_found', message: 'x' } }) : noOutputDefaults(url, init)));
    service.value = { ...view, sections: [{ id: 'sec', name: 'Welcome', items: [itemA, { ...itemA, id: 'r', kind: 'reading', title: 'Reading' }] }] };
    selection.value = { itemId: 'a' };
    drift.value = [{ itemId: 'a', latestRevision: 5 }, { itemId: 'r', latestRevision: 3 }];
    const { rerender } = render(<PropertiesPanel />);
    expect(await screen.findByText('The two revisions could not be read.')).toBeTruthy();

    selection.value = { itemId: 'r' };
    rerender(<PropertiesPanel />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'Update to revision 3' })).toBeTruthy();
  });

  it('shows no compare table for an item that has not drifted', () => {
    service.value = { ...view, sections: [{ id: 'sec', name: 'Welcome', items: [itemA] }] };
    selection.value = { itemId: 'a' };
    drift.value = [];
    render(<PropertiesPanel />);

    expect(screen.queryByRole('table')).toBeNull();
  });
});
