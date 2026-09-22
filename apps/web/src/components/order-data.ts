// The service order arrives as untrusted JSON, even though the web client is its first consumer. Keeping
// its shape next to the view means every route that renders an order uses the same validation rather than
// teaching a page-specific fetch path which malformed data is safe to show.

import { parseObject } from '@holydeck/contracts/problems';
import { SHORTCUT_KEYS, type SlideLabelEntry } from '@holydeck/contracts/slide-labels';

import type { OrderItem } from '../control-state.js';

/** The operator's current order and the live shortcut catalogue it is read against. */
export interface ControlData {
  readonly items: readonly OrderItem[];
  readonly catalogue: readonly SlideLabelEntry[];
}

/** Parses the order resource before any of its labels are put on screen. */
export const readControlData = (value: unknown) => parseObject<ControlData>(value, 'order', (reader) => ({
  items: reader.parsedList('items', (item, path) => parseObject(item, path, (fields) => ({
    id: fields.text('id'),
    label: fields.text('label'),
  }))),
  catalogue: reader.parsedList('catalogue', (entry, path) => parseObject(entry, path, (fields) => ({
    id: fields.text('id'),
    name: fields.text('name'),
    shortcut: fields.names.includes('shortcut') ? fields.choice('shortcut', SHORTCUT_KEYS) : undefined,
  }))),
}));
