// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetWorkspace, saveState } from '../state/workspace-store.js';
import { WorkspaceStatus } from './WorkspaceStatus.js';

beforeEach(() => {
  resetWorkspace();
});

describe('WorkspaceStatus', () => {
  it('says nothing while idle', () => {
    render(<WorkspaceStatus />);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it.each([
    ['saving', 'Saving…'],
    ['saved', 'Saved'],
    ['offline', 'Connection lost. Your last typed text is safe. Editing is paused while we reconnect.'],
    ['checking', 'Back online. Checking for newer changes…'],
  ] as const)('announces %s as %s', (state, text) => {
    saveState.value = state;
    render(<WorkspaceStatus />);
    expect(screen.getByRole('status').textContent).toBe(text);
  });

  it('reserves the collaboration slot for spec 09', () => {
    render(<WorkspaceStatus />);
    expect(document.querySelector('[data-slot="collaboration"]')).not.toBeNull();
  });
});
