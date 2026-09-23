// @vitest-environment happy-dom
// The confirmation every archive, restore and revision restore asks through: focus starts on its first
// action, Tab and Shift+Tab wrap inside it, Escape cancels it, and closing hands focus back to whatever
// opened it.

import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog.js';

const dialog = (props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) => (
  <ConfirmDialog
    id="test-confirm"
    title="Archive Amazing Grace?"
    body="It leaves the library."
    confirmLabel="Archive"
    cancelLabel="Cancel"
    onConfirm={vi.fn()}
    onCancel={vi.fn()}
    {...props}
  >
    <p>Used by 2 services.</p>
  </ConfirmDialog>
);

const tab = (target: Element, shiftKey = false): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};

describe('ConfirmDialog', () => {
  it('names itself by its title and body, shows its extra content, and focuses its first action', () => {
    render(dialog());
    const shown = screen.getByRole('alertdialog', { name: 'Archive Amazing Grace?' });
    expect(shown.getAttribute('aria-modal')).toBe('true');
    expect(shown.getAttribute('aria-describedby')).toBe('test-confirm-body');
    expect(screen.getByText('Used by 2 services.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Archive' }));
  });

  it('wraps Tab from the last action to the first and Shift+Tab from the first to the last', () => {
    render(dialog());
    const first = screen.getByRole('button', { name: 'Archive' });
    const last = screen.getByRole('button', { name: 'Cancel' });
    last.focus();
    expect(tab(last).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    expect(tab(first, true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('leaves Tab between two inner actions to the browser', () => {
    render(dialog());
    expect(tab(screen.getByRole('button', { name: 'Archive' })).defaultPrevented).toBe(false);
  });

  it('cancels on Escape, but not while busy', () => {
    const onCancel = vi.fn();
    const { rerender } = render(dialog({ onCancel, busy: true }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    rerender(dialog({ onCancel }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('confirms and cancels through its buttons, both disabled while busy', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(dialog({ onConfirm, onCancel }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(dialog({ busy: true }));
    expect(screen.getByRole('button', { name: 'Archive' }).hasAttribute('disabled')).toBe(true);
  });

  it('hands focus back to the control that opened it once it closes', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { unmount } = render(dialog());
    expect(document.activeElement).not.toBe(opener);
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
