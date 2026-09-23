// @vitest-environment happy-dom
// Toasts are independent timed messages, so these checks cover their defaults, focused pause accounting,
// and the explicit controls that remove only the message an operator chose to act on.

import { act, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { showToast, ToastRegion, toasts } from './toast.js';

beforeEach(() => {
  toasts.value = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ToastRegion', () => {
  it('dismisses a plain toast after its default 4 s', async () => {
    vi.useFakeTimers();
    showToast({ message: 'Saved' });
    render(<ToastRegion />);

    await vi.advanceTimersByTimeAsync(4000);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('dismisses the toast selected by its dismiss button', () => {
    showToast({ message: 'Saved' });
    render(<ToastRegion />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('dismisses only the focused toast when Escape is pressed', () => {
    showToast({ message: 'First' });
    showToast({ message: 'Second' });
    render(<ToastRegion />);
    const first = screen.getByText('First').closest('li') as HTMLLIElement;
    first.tabIndex = -1;
    first.focus();
    fireEvent.keyDown(first, { key: 'Escape' });

    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByText('Second')).toBeTruthy();
  });

  it('an undo toast lasts 8 s, pauses while focused, and runs its action', async () => {
    vi.useFakeTimers();
    const undo = vi.fn();
    showToast({ message: 'Undid: rename', action: { label: 'Undo', run: undo } });
    render(<ToastRegion />);
    const item = screen.getByText('Undid: rename').closest('li') as HTMLLIElement;

    await vi.advanceTimersByTimeAsync(7000);
    fireEvent.focusIn(item);
    await vi.advanceTimersByTimeAsync(8000);
    expect(screen.getByText('Undid: rename')).toBeTruthy();
    fireEvent.focusOut(item, { relatedTarget: document.body });
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.queryByText('Undid: rename')).toBeNull();

    act(() => {
      showToast({ message: 'Undid: delete', action: { label: 'Undo', run: undo } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Undid: delete')).toBeNull();
  });
});
