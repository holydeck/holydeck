// @vitest-environment happy-dom
// Autosave waits for the current edit to settle, but its explicit checkpoint and draft boundary must still
// preserve the newest value when a person saves deliberately or the page needs to recover unfinished work.

import { renderHook } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

const drafts = vi.hoisted(() => ({ saveDraft: vi.fn(), clearDraft: vi.fn() }));

vi.mock('../drafts.js', () => drafts);

import { useAutosave } from './use-autosave.js';

afterEach(() => {
  vi.useRealTimers();
  drafts.saveDraft.mockClear();
  drafts.clearDraft.mockClear();
});

describe('useAutosave', () => {
  it('saves once, 800 ms after the last change', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => true);
    const { rerender } = renderHook(({ v }) => useAutosave(v, save), { initialProps: { v: 'a' } });
    rerender({ v: 'ab' });
    vi.advanceTimersByTime(799);
    expect(save).not.toHaveBeenCalled();
    rerender({ v: 'abc' });
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('abc');
  });

  it('flush saves immediately and cancels the pending timer', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => true);
    const { result, rerender } = renderHook(({ v }) => useAutosave(v, save), { initialProps: { v: 'a' } });
    rerender({ v: 'latest' });

    await result.current.flush();
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith('latest');
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledOnce();
  });

  it('never saves after unmount or while disabled', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => true);
    const mounted = renderHook(({ v }) => useAutosave(v, save), { initialProps: { v: 'a' } });
    mounted.unmount();
    await vi.advanceTimersByTimeAsync(800);
    expect(save).not.toHaveBeenCalled();

    const disabled = renderHook(({ v }) => useAutosave(v, save, { enabled: false }), { initialProps: { v: 'a' } });
    disabled.rerender({ v: 'b' });
    await vi.advanceTimersByTimeAsync(800);
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps a draft while unsaved and clears it after Answered', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async () => true);
    renderHook(({ v }) => useAutosave(v, save, { draftKey: 'service' }), { initialProps: { v: { title: 'Sunday' } } });

    expect(drafts.saveDraft).toHaveBeenCalledWith('service', { title: 'Sunday' });
    await vi.advanceTimersByTimeAsync(800);
    expect(drafts.clearDraft).toHaveBeenCalledWith('service');
  });
});
