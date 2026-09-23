import { afterEach, describe, expect, it } from 'vitest';

import { successEnvelope } from '@holydeck/contracts/http';

import type { FetchLike } from '../api.js';
import type { ServiceView } from './service-data.js';

import { setFetching } from '../request.js';
import { loadOutputDefaults, outputDefaults, resolvedOutput, type OutputDefaults } from './output-defaults.js';

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const DEFAULTS_BODY = {
  aspectRatio: '16:9',
  safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
  uploadLimitBytes: 1_073_741_824,
};

const fakeFetch = (map: Record<string, ReturnType<typeof reply>>, calls: string[] = []): FetchLike =>
  async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    const response = map[key];
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return response;
  };

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', sections: [],
  revision: '2026-09-27T10:00:00.000Z',
};

const defaults: OutputDefaults = {
  aspectRatio: '16:9',
  safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
  uploadLimitBytes: 1_073_741_824,
};

afterEach(() => {
  outputDefaults.value = undefined;
});

describe('loadOutputDefaults', () => {
  it('fetches the output defaults and caches them', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({ 'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS_BODY, 'r1')) }, calls));

    await loadOutputDefaults();

    expect(calls).toEqual(['GET /api/v1/output-defaults']);
    expect(outputDefaults.value).toEqual(defaults);
  });

  it('never sends a second request once loaded, even when called again', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({ 'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS_BODY, 'r1')) }, calls));

    await loadOutputDefaults();
    await loadOutputDefaults();

    expect(calls).toEqual(['GET /api/v1/output-defaults']);
  });

  it('coalesces two calls that overlap in flight into one request', async () => {
    const calls: string[] = [];
    setFetching(fakeFetch({ 'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS_BODY, 'r1')) }, calls));

    await Promise.all([loadOutputDefaults(), loadOutputDefaults()]);

    expect(calls).toEqual(['GET /api/v1/output-defaults']);
    expect(outputDefaults.value).toEqual(defaults);
  });
});

describe('resolvedOutput', () => {
  it('prefers the defaults when the service carries no output override', () => {
    expect(resolvedOutput(view, defaults)).toEqual({
      aspectRatio: '16:9',
      safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
      source: 'default',
    });
  });

  it('treats an empty override the same as no override at all', () => {
    expect(resolvedOutput({ ...view, output: {} }, defaults)).toMatchObject({ source: 'default' });
  });

  it('prefers the service own output when it set one', () => {
    const overridden: ServiceView = {
      ...view,
      output: { aspectRatio: '4:3', safeAreaMargins: { top: 10, right: 10, bottom: 10, left: 10, unit: 'percent' } },
    };
    expect(resolvedOutput(overridden, defaults)).toEqual({
      aspectRatio: '4:3',
      safeAreaMargins: { top: 10, right: 10, bottom: 10, left: 10, unit: 'percent' },
      source: 'service',
    });
  });
});
