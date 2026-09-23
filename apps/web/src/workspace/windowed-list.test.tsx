// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WindowedList } from './windowed-list.js';

const ROW_HEIGHT = 40;
const rows = Array.from({ length: 201 }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}` }));

let originalResizeObserver: typeof ResizeObserver | undefined;

beforeEach(() => {
  originalResizeObserver = globalThis.ResizeObserver;
});

afterEach(() => {
  if (originalResizeObserver === undefined) {
    // @ts-expect-error -- restoring the environment's own absence of the global for the next test.
    delete globalThis.ResizeObserver;
  } else {
    globalThis.ResizeObserver = originalResizeObserver;
  }
});

class StubResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const stubViewport = (element: HTMLElement, heightPx: number): void => {
  Object.defineProperty(element, 'clientHeight', { value: heightPx, configurable: true });
};

describe('WindowedList', () => {
  it('renders every row at or below the threshold', () => {
    const few = rows.slice(0, 5);
    render(
      <WindowedList
        items={few}
        rowHeightPx={ROW_HEIGHT}
        threshold={200}
        keyOf={(row) => row.id}
        render={(row) => <span data-testid={row.id}>{row.label}</span>}
      />,
    );
    for (const row of few) expect(screen.getByTestId(row.id)).toBeTruthy();
  });

  it('renders every row at 200 and a window above it, keeping the focused row', () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    const { container } = render(
      <WindowedList
        items={rows}
        rowHeightPx={ROW_HEIGHT}
        threshold={200}
        keyOf={(row) => row.id}
        render={(row) => <button type="button" data-testid={row.id}>{row.label}</button>}
      />,
    );
    const viewport = container.querySelector('[data-testid="windowed-list-viewport"]') as HTMLElement;
    stubViewport(viewport, 400);
    fireEvent.scroll(viewport, { target: { scrollTop: 0 } });

    const renderedCount = rows.filter((row) => screen.queryByTestId(row.id) !== null).length;
    expect(renderedCount).toBeGreaterThan(0);
    expect(renderedCount).toBeLessThan(60);
    expect(screen.queryByTestId('row-150')).toBeNull();

    // Scroll row 150 into view and focus it.
    Object.defineProperty(viewport, 'scrollTop', { value: 150 * ROW_HEIGHT, configurable: true, writable: true });
    fireEvent.scroll(viewport);
    const row150 = screen.getByTestId('row-150');
    row150.focus();
    expect(document.activeElement).toBe(row150);

    // Scroll back to the top: row 150 must still be in the DOM because it holds focus.
    Object.defineProperty(viewport, 'scrollTop', { value: 0, configurable: true, writable: true });
    fireEvent.scroll(viewport);

    expect(screen.getByTestId('row-150')).toBe(row150);
    const renderedAfter = rows.filter((row) => screen.queryByTestId(row.id) !== null).length;
    expect(renderedAfter).toBeLessThan(60);
  });

  it('falls back to rendering every row when ResizeObserver is unavailable', () => {
    // @ts-expect-error -- simulating a runtime (e.g. some happy-dom setups) without ResizeObserver.
    delete globalThis.ResizeObserver;
    render(
      <WindowedList
        items={rows}
        rowHeightPx={ROW_HEIGHT}
        threshold={200}
        keyOf={(row) => row.id}
        render={(row) => <span data-testid={row.id}>{row.label}</span>}
      />,
    );
    for (const row of rows) expect(screen.getByTestId(row.id)).toBeTruthy();
  });

  it('uses the given overscan on both sides of the visible window', () => {
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    const { container } = render(
      <WindowedList
        items={rows}
        rowHeightPx={ROW_HEIGHT}
        threshold={200}
        overscan={2}
        keyOf={(row) => row.id}
        render={(row) => <span data-testid={row.id}>{row.label}</span>}
      />,
    );
    const viewport = container.querySelector('[data-testid="windowed-list-viewport"]') as HTMLElement;
    stubViewport(viewport, 80);
    fireEvent.scroll(viewport, { target: { scrollTop: 0 } });

    // viewport shows 2 rows (80/40); with overscan 2 on each side that is at most 6 rows.
    const renderedCount = rows.filter((row) => screen.queryByTestId(row.id) !== null).length;
    expect(renderedCount).toBeLessThanOrEqual(6);
  });
});
