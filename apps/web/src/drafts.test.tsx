// @vitest-environment happy-dom
// Draft persistence has to work around a browser-owned storage boundary, while the hook proof renders
// the same form twice to show that the value written by its first lifetime becomes the second's initial state.

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAppState } from './app-state.js';
import { clearAllDrafts, DRAFT_PREFIX, readDraft, saveDraft, useDraft } from './drafts.js';

import type { JSX } from 'preact';

const DraftForm = (): JSX.Element => {
  const [draft, setDraft] = useDraft('service', { name: '' });
  return <input aria-label="Name" value={draft.name} onInput={(event) => setDraft({ name: event.currentTarget.value })} />;
};

beforeEach(() => {
  resetAppState();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('form drafts', () => {
  it('round-trips safe string fields', () => {
    saveDraft('service', { name: 'Sunday', notes: 'Psalm 23' });

    expect(readDraft('service')).toEqual({ name: 'Sunday', notes: 'Psalm 23' });
  });

  it('does not throw when browser storage refuses reads or writes', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('storage denied'); },
      setItem: () => { throw new Error('storage denied'); },
      removeItem: () => { throw new Error('storage denied'); },
    });

    expect(() => saveDraft('service', { name: 'Sunday' })).not.toThrow();
    expect(readDraft('service')).toBeUndefined();
  });

  it('treats malformed JSON as no draft', () => {
    sessionStorage.setItem(`${DRAFT_PREFIX}service`, '{not json');

    expect(readDraft('service')).toBeUndefined();
  });

  it('drops password and code fields before writing browser storage', () => {
    saveDraft('sign-in', { name: 'Ruth', password: 'secret', secondCode: '123456' });

    expect(readDraft('sign-in')).toEqual({ name: 'Ruth' });
  });

  it('removes every draft in this tab without touching another session record', () => {
    saveDraft('service', { name: 'Sunday' });
    saveDraft('users', { name: 'Ruth' });
    sessionStorage.setItem('holydeck:locale', 'en');

    clearAllDrafts();

    expect(sessionStorage.getItem(`${DRAFT_PREFIX}service`)).toBeNull();
    expect(sessionStorage.getItem(`${DRAFT_PREFIX}users`)).toBeNull();
    expect(sessionStorage.getItem('holydeck:locale')).toBe('en');
  });

  it('does not throw when browser storage refuses clearing every draft', () => {
    vi.stubGlobal('sessionStorage', {
      get length(): number { throw new Error('storage denied'); },
      key: () => null,
      removeItem: () => { throw new Error('storage denied'); },
    });

    expect(() => clearAllDrafts()).not.toThrow();
  });

  it('restores a saved value after the form unmounts and mounts again', () => {
    const first = render(<DraftForm />);
    fireEvent.input(screen.getByLabelText('Name'), { target: { value: 'Sunday service' } });
    first.unmount();

    render(<DraftForm />);

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Sunday service');
  });
});
