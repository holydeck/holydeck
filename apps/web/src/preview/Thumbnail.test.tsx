// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';

import type { FetchLike } from '../api.js';
import { setFetching } from '../request.js';
import { resetWorkspace, service } from '../state/workspace-store.js';
import { outputDefaults } from '../workspace/output-defaults.js';
import type { ServiceView } from '../workspace/service-data.js';
import { Thumbnail } from './Thumbnail.js';

const DEFAULTS = {
  aspectRatio: '16:9',
  safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
  uploadLimitBytes: 1_073_741_824,
};

const welcome: ServiceItem = {
  id: 'i1', kind: 'custom-slide', title: 'Welcome', enabled: true, content: undefined,
  body: {
    kind: 'custom-slide',
    boxes: [{
      id: 't1', kind: 'text', frame: { x: 0.1, y: 0.1, width: 0.8, height: 0.3 }, layer: 0, text: 'Welcome',
      style: { fontFamily: 'var(--font-latin)', fontWeight: 400, sizeRatio: 0.05, lineHeight: 1.2, align: 'center', verticalAlign: 'center' },
    }],
  },
};

const calls: string[] = [];
const fetching: FetchLike = async (url, init) => {
  calls.push(`${init.method ?? 'GET'} ${url}`);
  return { status: 200, json: async (): Promise<unknown> => successEnvelope(DEFAULTS, 'r-d') };
};

beforeEach(() => {
  resetWorkspace();
  outputDefaults.value = undefined;
  calls.length = 0;
  setFetching(fetching);
  const view: ServiceView = {
    id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
    sections: [{ id: 'sec1', name: 'Worship', items: [welcome] }],
  };
  service.value = view;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
    font: '',
    measureText: (text: string) => ({ width: text.length * 10 }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Thumbnail', () => {
  it('paints the item at thumbnail width where visibility cannot be observed', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    render(<Thumbnail itemId="i1" />);

    const image = await screen.findByRole('img', { name: 'Preview of Welcome' });
    expect(image.style.width).toBe('240px');
    expect(image.style.height).toBe('135px');
  });

  it('shows a placeholder and fetches nothing until the row scrolls into view', async () => {
    let notify: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { notify = callback; }
      observe(): void {}
      disconnect(): void { disconnect(); }
    });

    const { container } = render(<Thumbnail itemId="i1" />);
    expect(container.querySelector('.thumbnail-placeholder')).not.toBeNull();
    expect(calls).toEqual([]);

    notify?.([{ isIntersecting: true }]);
    expect(await screen.findByRole('img', { name: 'Preview of Welcome' })).toBeTruthy();
    expect(disconnect).toHaveBeenCalled();
  });
});
