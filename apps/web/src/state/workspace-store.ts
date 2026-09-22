// The one place a workspace screen reads or changes a service: it never edits `service` optimistically,
// so nothing on screen claims a save succeeded before the server has actually answered it.

import { NOT_FOUND } from '@holydeck/contracts/http';
import { effect, signal, type Signal } from '@preact/signals';

import { API } from '../api-routes.js';
import { csrf } from '../app-state.js';
import { NETWORK_UNREACHABLE, type ApiResult, type Change, type Refused } from '../api.js';
import { request } from '../request.js';
import { readServiceView, type ServiceView } from '../workspace/service-data.js';

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'checking';

export const service: Signal<ServiceView | undefined> = signal(undefined);
export const loadState: Signal<'idle' | 'loading' | 'loaded' | 'missing' | 'error'> = signal('idle');
export const loadRefusal: Signal<Refused | undefined> = signal(undefined);
export const selection: Signal<{ itemId?: string; slideId?: string }> = signal({});
export const saveState: Signal<SaveState> = signal('idle');
export const drift: Signal<readonly { itemId: string; latestRevision: number }[]> = signal([]);
export const rightTab: Signal<'properties' | 'library'> = signal(readRightTab());
export const bulkSelection: Signal<ReadonlySet<string>> = signal(new Set());
export const pending: Signal<ReadonlySet<string>> = signal(new Set());

const RIGHT_TAB_KEY = 'holydeck.workspace.rightTab';

function readRightTab(): 'properties' | 'library' {
  try {
    const raw = globalThis.localStorage.getItem(RIGHT_TAB_KEY);
    return raw === 'library' ? 'library' : 'properties';
  } catch {
    return 'properties';
  }
}

effect(() => {
  try {
    globalThis.localStorage.setItem(RIGHT_TAB_KEY, rightTab.value);
  } catch {
    // Browser storage can be absent, full or unavailable in a private browsing context.
  }
});

export async function loadService(id: string): Promise<void> {
  loadState.value = 'loading';
  loadRefusal.value = undefined;
  const answer = await request(API.service(id));
  if (answer.ok) {
    const view = readServiceView(answer.data);
    if (view === undefined) {
      service.value = undefined;
      loadState.value = 'error';
      return;
    }
    service.value = view;
    loadState.value = 'loaded';
    await refreshDrift();
    return;
  }
  service.value = undefined;
  loadRefusal.value = answer;
  loadState.value = answer.code === NOT_FOUND ? 'missing' : 'error';
}

export async function mutate(path: string, change: Omit<Change, 'csrf'>, pendingId?: string): Promise<ApiResult<ServiceView>> {
  if (pendingId !== undefined) pending.value = new Set(pending.value).add(pendingId);
  saveState.value = 'saving';
  try {
    const answer = await request(path, { ...change, csrf: csrf() ?? '' });
    if (answer.ok) {
      const view = readServiceView(answer.data);
      saveState.value = 'saved';
      if (view !== undefined) {
        service.value = view;
        await refreshDrift();
      }
    } else {
      saveState.value = answer.code === NETWORK_UNREACHABLE ? 'offline' : 'idle';
    }
    return answer as ApiResult<ServiceView>;
  } finally {
    if (pendingId !== undefined) {
      const next = new Set(pending.value);
      next.delete(pendingId);
      pending.value = next;
    }
  }
}

const isDrift = (value: unknown): value is { itemId: string; contentId: string; pinnedRevision: number; latestRevision: number; drifted: boolean } =>
  typeof value === 'object' && value !== null && !Array.isArray(value) &&
  typeof (value as Record<string, unknown>).itemId === 'string' &&
  typeof (value as Record<string, unknown>).contentId === 'string' &&
  typeof (value as Record<string, unknown>).pinnedRevision === 'number' &&
  typeof (value as Record<string, unknown>).latestRevision === 'number' &&
  typeof (value as Record<string, unknown>).drifted === 'boolean';

export async function refreshDrift(): Promise<void> {
  if (service.value === undefined) return;
  const answer = await request(API.serviceDrift(service.value.id));
  if (!answer.ok || !Array.isArray(answer.data) || !answer.data.every(isDrift)) return;
  drift.value = answer.data
    .filter(({ drifted }) => drifted)
    .map(({ itemId, latestRevision }) => ({ itemId, latestRevision }));
}

export function resetWorkspace(): void {
  service.value = undefined;
  loadState.value = 'idle';
  loadRefusal.value = undefined;
  selection.value = {};
  saveState.value = 'idle';
  drift.value = [];
  rightTab.value = readRightTab();
  bulkSelection.value = new Set();
  pending.value = new Set();
}
