// Renders a long row list without putting every row in the DOM at once. Below `threshold` rows this is
// just a plain list — virtualizing a short list buys nothing and only adds scroll-math bugs. Above it, only
// the rows inside the visible viewport (plus `overscan` on each side) are mounted, inside a spacer sized to
// the full list's height so the scrollbar still reflects the true row count. A row that currently holds DOM
// focus is always kept mounted even when it scrolls out of the window, so focus is never silently dropped.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact/jsx-runtime';

const DEFAULT_OVERSCAN = 10;
const DEFAULT_THRESHOLD = 200;

export function WindowedList<T>(props: {
  items: readonly T[];
  rowHeightPx: number;
  overscan?: number;
  threshold?: number;
  keyOf: (item: T) => string;
  render: (item: T, index: number) => JSX.Element | string | null;
}): JSX.Element {
  const { items, rowHeightPx, keyOf, render } = props;
  const overscan = props.overscan ?? DEFAULT_OVERSCAN;
  const threshold = props.threshold ?? DEFAULT_THRESHOLD;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | undefined>(undefined);
  const [supportsResizeObserver] = useState(() => typeof ResizeObserver !== 'undefined');

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || !supportsResizeObserver) return;
    setViewportHeight(viewport.clientHeight);
    const observer = new ResizeObserver(() => {
      setViewportHeight(viewport.clientHeight);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [supportsResizeObserver]);

  const virtualize = supportsResizeObserver && items.length > threshold;

  const range = useMemo(() => {
    if (!virtualize) return { start: 0, end: items.length };
    const firstVisible = Math.floor(scrollTop / rowHeightPx);
    const visibleCount = Math.ceil(viewportHeight / rowHeightPx) + 1;
    const start = Math.max(0, firstVisible - overscan);
    const end = Math.min(items.length, firstVisible + visibleCount + overscan);
    return { start, end };
  }, [virtualize, scrollTop, viewportHeight, rowHeightPx, overscan, items.length]);

  const focusedIndex = useMemo(() => {
    if (focusedKey === undefined) return -1;
    return items.findIndex((item) => keyOf(item) === focusedKey);
  }, [focusedKey, items, keyOf]);

  const onScroll = (event: JSX.TargetedEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  const onFocusIn = (event: JSX.TargetedFocusEvent<HTMLDivElement>): void => {
    const rowElement = (event.target as HTMLElement | null)?.closest('[data-row-key]');
    const key = rowElement?.getAttribute('data-row-key') ?? undefined;
    setFocusedKey(key);
  };

  const onFocusOut = (): void => {
    setFocusedKey(undefined);
  };

  // `role="presentation"` on every wrapper div: a caller such as OrderPanel renders this inside an
  // `role="list"` around `<li>` rows, and these wrappers exist only for positioning/keying, not to mean
  // anything themselves — without it, browsers vary on whether the list/`<li>` relationship
  // survives a `<div>` in between, which would silently drop list semantics for assistive tech.
  if (!virtualize) {
    return (
      <div data-testid="windowed-list-viewport" role="presentation" ref={viewportRef}>
        {items.map((item, index) => {
          const key = keyOf(item);
          return (
            <div key={key} data-row-key={key} role="presentation">
              {render(item, index)}
            </div>
          );
        })}
      </div>
    );
  }

  const rows: JSX.Element[] = [];
  const included = new Set<number>();
  for (let index = range.start; index < range.end; index += 1) {
    included.add(index);
  }
  if (focusedIndex >= 0 && !included.has(focusedIndex)) {
    included.add(focusedIndex);
  }

  for (const index of [...included].sort((a, b) => a - b)) {
    const item = items[index];
    if (item === undefined) continue;
    const key = keyOf(item);
    rows.push(
      <div
        key={key}
        data-row-key={key}
        role="presentation"
        style={{ position: 'absolute', top: `${index * rowHeightPx}px`, left: 0, right: 0, height: `${rowHeightPx}px` }}
      >
        {render(item, index)}
      </div>,
    );
  }

  return (
    <div
      data-testid="windowed-list-viewport"
      role="presentation"
      ref={viewportRef}
      onScroll={onScroll}
      onFocusIn={onFocusIn}
      onFocusOut={onFocusOut}
      style={{ position: 'relative', overflow: 'auto' }}
    >
      <div role="presentation" style={{ position: 'relative', height: `${items.length * rowHeightPx}px` }}>{rows}</div>
    </div>
  );
}
