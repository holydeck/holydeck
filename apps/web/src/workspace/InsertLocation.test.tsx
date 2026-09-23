// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountRecord } from '@holydeck/contracts/accounts';
import { errorEnvelope, successEnvelope } from '@holydeck/contracts/http';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { SessionView } from '@holydeck/contracts/sessions';

import type { FetchLike } from '../api.js';
import { session } from '../app-state.js';
import { setFetching } from '../request.js';
import { resetWorkspace, selection, service } from '../state/workspace-store.js';
import { defaultTarget, insertAndSelect, insertAt, InsertLocation } from './InsertLocation.js';
import type { ServiceView } from './service-data.js';

const me: AccountRecord = {
  id: 'GLkQ5wEtQEy5PfN2Zr9m7A', name: 'andru', displayName: 'Andru Example', role: 'admin',
  createdAt: '2026-09-13T09:30:00.000Z', controlPresentation: true, disabled: false,
};

const reply = (status: number, body: unknown) => ({ status, json: async (): Promise<unknown> => body });
const item = (id: string): ServiceItem => ({ id, kind: 'custom-slide', title: `Item ${id}`, enabled: true, content: undefined });
const viewWith = (main: string[], other: string[] = []): ServiceView => ({
  id: 's1', title: 'Sunday', date: '2026-09-27', site: 'Main Hall', state: 'upcoming', revision: 'r0',
  sections: [{ id: 'main', name: 'Main', items: main.map(item) }, { id: 'end', name: 'Ending', items: other.map(item) }],
});

const asRecord = (view: ServiceView) => {
  const { id, revision, ...rest } = view;
  return { stamp: { id, updatedAt: revision }, ...rest };
};

const bodies = new Map<string, unknown>();
const fakeFetch = (map: Record<string, ReturnType<typeof reply>>): FetchLike => async (url, init) => {
  const key = `${init.method ?? 'GET'} ${url}`;
  if (init.body !== undefined) bodies.set(key, JSON.parse(String(init.body)));
  const response = map[key];
  if (response === undefined) throw new Error(`No reply for ${key}`);
  return response;
};

const ITEMS = 'POST /api/v1/services/s1/sections/main/items';
const REORDER = 'POST /api/v1/services/s1/sections/main/items/reorder';
const noDrift = reply(200, successEnvelope([], 'r'));

beforeEach(() => {
  resetWorkspace();
  bodies.clear();
  session.value = {
    account: me, actor: `account:${me.id}`, permissions: ['services.manage'],
    startedAt: '2026-09-13T09:30:00.000Z', lastSeenAt: '2026-09-13T09:30:00.000Z',
    expiresAt: '2026-09-14T09:30:00.000Z', rotation: 'authentication', csrf: 'c'.repeat(43), slots: [],
  } satisfies SessionView;
});

describe('defaultTarget', () => {
  it('follows the selected item, else the end of the first section, else nothing', () => {
    expect(defaultTarget(viewWith(['a'], ['b']), 'b')).toEqual({ sectionId: 'end', afterItemId: 'b' });
    expect(defaultTarget(viewWith(['a']), 'gone')).toEqual({ sectionId: 'main' });
    expect(defaultTarget(viewWith(['a']), undefined)).toEqual({ sectionId: 'main' });
    expect(defaultTarget({ ...viewWith([]), sections: [] }, undefined)).toBeUndefined();
  });
});

describe('insertAt', () => {
  it('appends only, when the target is the end or the last item', async () => {
    setFetching(fakeFetch({ [ITEMS]: reply(201, successEnvelope(asRecord(viewWith(['a', 'b', 'n'])), 'r')), 'GET /api/v1/services/s1/content-drift': noDrift }));
    const result = await insertAt(viewWith(['a', 'b']), { sectionId: 'main', afterItemId: 'b' }, item('n'));
    expect(result.ok).toBe(true);
    expect(bodies.has(REORDER)).toBe(false);
  });

  it('appends, then moves the new item right after the target', async () => {
    setFetching(fakeFetch({
      [ITEMS]: reply(201, successEnvelope(asRecord(viewWith(['a', 'b', 'n'])), 'r')),
      [REORDER]: reply(200, successEnvelope(asRecord(viewWith(['a', 'n', 'b'])), 'r')),
      'GET /api/v1/services/s1/content-drift': noDrift,
    }));
    await insertAt(viewWith(['a', 'b']), { sectionId: 'main', afterItemId: 'a' }, item('n'));
    expect(bodies.get(REORDER)).toEqual({ itemIds: ['a', 'n', 'b'] });
    expect(service.value?.sections[0]?.items.map((entry) => entry.id)).toEqual(['a', 'n', 'b']);
  });

  it('stops at a refused append and selects nothing', async () => {
    setFetching(fakeFetch({ [ITEMS]: reply(404, errorEnvelope('services.not_found', 'Gone.', 'r')) }));
    service.value = viewWith(['a']);
    expect(await insertAndSelect({ sectionId: 'main', afterItemId: 'a' }, item('n'))).toBe(false);
    expect(selection.value.itemId).toBeUndefined();
    expect(bodies.has(REORDER)).toBe(false);
  });

  it('answers false with no service loaded', async () => {
    expect(await insertAndSelect({ sectionId: 'main' }, item('n'))).toBe(false);
  });
});

describe('InsertLocation', () => {
  it('offers every section and each position, and reports the choice', () => {
    service.value = viewWith(['a', 'b'], ['c']);
    const onChange = vi.fn();
    render(<InsertLocation idPrefix="t" value={{ sectionId: 'main', afterItemId: 'a' }} onChange={onChange} />);

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Main', 'Ending', 'After Item a', 'After Item b', 'At the end',
    ]);
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenLastCalledWith({ sectionId: 'main', afterItemId: 'b' });
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ sectionId: 'main' });
    fireEvent.change(screen.getByLabelText('Insert into section'), { target: { value: 'end' } });
    expect(onChange).toHaveBeenLastCalledWith({ sectionId: 'end' });
  });

  it('renders nothing without a target', () => {
    service.value = { ...viewWith([]), sections: [] };
    const { container } = render(<InsertLocation idPrefix="t" value={undefined} onChange={() => {}} />);
    expect(container.innerHTML).toBe('');
  });
});
