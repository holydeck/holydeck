// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { ENTITY_CONFLICT, errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { resetWorkspace, service } from '../state/workspace-store.js';
import { outputDefaults } from './output-defaults.js';
import { OutputProfile } from './OutputProfile.js';
import type { ServiceView } from './service-data.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};
const csrf = 'c'.repeat(43);

const signedIn = (): SessionView => ({
  account: me, actor: `account:${me.id}`, permissions: ['services.manage'],
  startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
  expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf, slots: [],
});

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });

const view: ServiceView = {
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', sections: [],
  revision: 'r0',
};

const DEFAULTS_BODY = {
  aspectRatio: '16:9',
  safeAreaMargins: { top: 5, right: 5, bottom: 5, left: 5, unit: 'percent' },
  uploadLimitBytes: 1_073_741_824,
};

const record = (revision: string, output?: unknown) => ({
  stamp: {
    id: 's1', kind: 'service', schemaVersion: 1, createdAt: '2026-09-27T10:00:00.000Z', createdBy: 'account:andru',
    updatedAt: revision, updatedBy: 'account:andru',
  },
  title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', sections: [],
  ...(output === undefined ? {} : { output }),
});

const fakeFetch = (map: Record<string, ReturnType<typeof reply>>, calls: string[] = []): FetchLike =>
  async (url, init) => {
    const key = `${init.method ?? 'GET'} ${url}`;
    calls.push(key);
    const response = map[key];
    if (response === undefined) throw new Error(`No reply for ${key}`);
    return response;
  };

beforeEach(() => {
  resetWorkspace();
  outputDefaults.value = undefined;
  session.value = signedIn();
  service.value = view;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OutputProfile', () => {
  it('shows the default ratio, then saves a chosen standard ratio and shows it as the service own', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    setFetching(fakeFetch({
      'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS_BODY, 'r-defaults')),
      'PATCH /api/v1/services/s1/output': reply(200, successEnvelope(record('r1', { aspectRatio: '4:3' }), 'r-save')),
    }, calls));

    render(<OutputProfile />);
    await vi.waitFor(() => expect(screen.getByText('Aspect ratio: 16:9 (default)')).toBeTruthy());

    fireEvent.click(screen.getByRole('radio', { name: '4:3' }));
    await vi.advanceTimersByTimeAsync(800);

    expect(calls).toContain('PATCH /api/v1/services/s1/output');
    await vi.waitFor(() => expect(screen.getByText('Aspect ratio: 4:3 (this service)')).toBeTruthy());
  });

  it('never sends a request for an invalid custom ratio, and shows the inline error instead', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    setFetching(fakeFetch({
      'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS_BODY, 'r-defaults')),
    }, calls));

    render(<OutputProfile />);
    await vi.waitFor(() => expect(screen.getByText('Aspect ratio: 16:9 (default)')).toBeTruthy());

    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.input(screen.getByLabelText('Custom ratio (W:H)'), { target: { value: '0:9' } });
    await vi.advanceTimersByTimeAsync(800);

    expect(screen.getByText('Enter a ratio like 21:9.')).toBeTruthy();
    expect(calls).toEqual(['GET /api/v1/output-defaults']);
  });

  it('shows the locked notice when the service refuses the save because it is presenting', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    setFetching(fakeFetch({
      'GET /api/v1/output-defaults': reply(200, successEnvelope(DEFAULTS_BODY, 'r-defaults')),
      'PATCH /api/v1/services/s1/output': reply(
        409,
        errorEnvelope(ENTITY_CONFLICT, "The output can't change while the service is presenting.", 'r-conflict'),
      ),
    }, calls));

    render(<OutputProfile />);
    await vi.waitFor(() => expect(screen.getByText('Aspect ratio: 16:9 (default)')).toBeTruthy());

    fireEvent.click(screen.getByRole('radio', { name: '4:3' }));
    await vi.advanceTimersByTimeAsync(800);

    await vi.waitFor(() => expect(screen.getByText("The output can't change while the service is presenting.")).toBeTruthy());
  });
});
