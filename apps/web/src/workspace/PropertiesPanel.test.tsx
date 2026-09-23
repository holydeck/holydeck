// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ServiceItem } from '@holydeck/contracts/services';

import type { ServiceView } from './service-data.js';

import { drift, resetWorkspace, selection, service } from '../state/workspace-store.js';
import { PropertiesPanel } from './PropertiesPanel.js';

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', sections: [],
  revision: '2026-09-27T10:00:00.000Z',
};

const itemA: ServiceItem = {
  id: 'a', kind: 'song', title: 'Song A', enabled: true, content: { id: 'c1', revision: 2, hash: undefined },
};

beforeEach(() => {
  resetWorkspace();
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
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows a read-only compare for the selected item once it has drifted', () => {
    service.value = { ...view, sections: [{ id: 'sec', name: 'Welcome', items: [itemA] }] };
    selection.value = { itemId: 'a' };
    drift.value = [{ itemId: 'a', latestRevision: 5 }];
    render(<PropertiesPanel />);

    expect(screen.getByRole('columnheader', { name: 'Pinned revision 2' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Latest revision 5' })).toBeTruthy();
    expect(screen.getAllByText('Song A')).toHaveLength(2);
    expect(screen.getByText('A side-by-side comparison of the text appears once content details can be read here.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update to revision 5' })).toBeTruthy();
  });

  it('shows no compare table for an item that has not drifted', () => {
    service.value = { ...view, sections: [{ id: 'sec', name: 'Welcome', items: [itemA] }] };
    selection.value = { itemId: 'a' };
    drift.value = [];
    render(<PropertiesPanel />);

    expect(screen.queryByRole('table')).toBeNull();
  });
});
