// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ServiceView } from './service-data.js';

import { resetWorkspace, service } from '../state/workspace-store.js';
import { PropertiesPanel } from './PropertiesPanel.js';

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', sections: [],
  revision: '2026-09-27T10:00:00.000Z',
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
});
