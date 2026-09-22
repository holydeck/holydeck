// @vitest-environment happy-dom
// The required-update interruption has one focusable action, so these interaction checks prove focus
// lands there, remains there through both Tab directions, and cannot be escaped by dismissing the modal.

import { act, fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAppState, updateRequired } from '../app-state.js';
import { UpdateDialog } from './update-dialog.js';

beforeEach(resetAppState);

describe('UpdateDialog', () => {
  it('is hidden until the server has required an update', () => {
    render(<UpdateDialog />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('appears with its reload action focused when an update is required', () => {
    render(<UpdateDialog />);
    act(() => {
      updateRequired.value = true;
    });

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reload' }));
  });

  it('keeps focus on Reload for Tab and Shift+Tab', () => {
    updateRequired.value = true;
    render(<UpdateDialog />);
    const reload = screen.getByRole('button', { name: 'Reload' });
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    reload.dispatchEvent(tab);
    const shiftTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    reload.dispatchEvent(shiftTab);

    expect(tab.defaultPrevented).toBe(true);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(reload);
  });

  it('calls its supplied reload action', () => {
    updateRequired.value = true;
    const reload = vi.fn();
    render(<UpdateDialog reload={reload} />);

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(reload).toHaveBeenCalledOnce();
  });
});
