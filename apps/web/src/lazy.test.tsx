// @vitest-environment happy-dom
import { render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAppState } from './app-state.js';
import { lazy } from './lazy.js';

import type { JSX } from 'preact';

describe('a page loaded from its own chunk', () => {
  beforeEach(() => resetAppState());

  it('says it is loading, then renders the page with its props, asking for the chunk once', async () => {
    const load = vi.fn(() => Promise.resolve(({ name }: { name: string }) => <h1>{name}</h1>));
    const Page = lazy(load);

    const first = render(<Page name="Order" />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect(await screen.findByRole('heading', { name: 'Order' })).toBeTruthy();
    first.unmount();

    render(<Page name="Again" />);
    expect(screen.getByRole('heading', { name: 'Again' })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('says the network failed when the chunk cannot be fetched, and asks again next time', async () => {
    const load = vi.fn()
      .mockReturnValueOnce(Promise.reject(new Error('offline')))
      .mockReturnValueOnce(Promise.resolve(() => <h1>Back</h1>));
    const Page = lazy<object>(load);

    const first = render(<Page />);
    expect(await screen.findByText(/could not be reached/u)).toBeTruthy();
    first.unmount();

    render(<Page />);
    expect(await screen.findByRole('heading', { name: 'Back' })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('ignores a chunk that arrives after the page was left', async () => {
    let resolve: (component: () => JSX.Element) => void = () => undefined;
    const Page = lazy<object>(() => new Promise((done) => { resolve = done; }));
    const view = render(<Page />);
    view.unmount();
    resolve(() => <h1>Late</h1>);
    await Promise.resolve();
    expect(screen.queryByRole('heading')).toBeNull();
  });
});
