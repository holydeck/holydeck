// WS-11's shared half: the administrative output profile every Service falls back to when it carries no
// override of its own, fetched once and cached — later screens (Tasks 18, 26) call `loadOutputDefaults`
// again expecting exactly one request, not one per caller.

import { isRecord } from '@holydeck/contracts/problems';
import { aspectRatioOf, parseSafeAreaMargins, type SafeAreaMargins } from '@holydeck/contracts/snapshots';
import { signal, type Signal } from '@preact/signals';

import { API } from '../api-routes.js';
import { request } from '../request.js';

import type { ServiceView } from './service-data.js';

export type OutputDefaults = {
  readonly aspectRatio: string;
  readonly safeAreaMargins: SafeAreaMargins;
  readonly uploadLimitBytes: number;
};

export const outputDefaults: Signal<OutputDefaults | undefined> = signal(undefined);

function readOutputDefaults(data: unknown): OutputDefaults | undefined {
  if (!isRecord(data)) return undefined;
  const { aspectRatio, uploadLimitBytes, safeAreaMargins } = data;
  if (typeof aspectRatio !== 'string' || aspectRatioOf(aspectRatio) === undefined) return undefined;
  if (typeof uploadLimitBytes !== 'number') return undefined;
  const margins = parseSafeAreaMargins(safeAreaMargins, 'safeAreaMargins');
  if (!margins.ok) return undefined;
  return { aspectRatio, safeAreaMargins: margins.value, uploadLimitBytes };
}

let inFlight: Promise<void> | undefined;

/** Fetches the output defaults once. Already loaded or already in flight, this is a no-op that resolves
 *  once the existing fetch settles, so a screen never has to know whether it is the first caller. */
export function loadOutputDefaults(): Promise<void> {
  if (outputDefaults.value !== undefined) return Promise.resolve();
  if (inFlight === undefined) {
    inFlight = (async () => {
      const answer = await request(API.outputDefaults);
      if (answer.ok) {
        const parsed = readOutputDefaults(answer.data);
        if (parsed !== undefined) outputDefaults.value = parsed;
      }
    })().finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}

/** The output profile a Service actually renders with: its own override where it set one, else the
 *  shared defaults. `view.output` carrying an empty object means the same as carrying none at all — that
 *  is how "Use Default" clears an override. */
export function resolvedOutput(
  view: ServiceView,
  defaults: OutputDefaults,
): { readonly aspectRatio: string; readonly safeAreaMargins: SafeAreaMargins; readonly source: 'default' | 'service' } {
  const override = view.output;
  if (override?.aspectRatio === undefined && override?.safeAreaMargins === undefined) {
    return { aspectRatio: defaults.aspectRatio, safeAreaMargins: defaults.safeAreaMargins, source: 'default' };
  }
  return {
    aspectRatio: override.aspectRatio ?? defaults.aspectRatio,
    safeAreaMargins: override.safeAreaMargins ?? defaults.safeAreaMargins,
    source: 'service',
  };
}
