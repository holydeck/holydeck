// The one place a workspace screen reads or changes a service: it never edits `service` optimistically,
// so nothing on screen claims a save succeeded before the server has actually answered it.

import { NOT_FOUND } from '@holydeck/contracts/http';
import { computed, effect, signal, type ReadonlySignal, type Signal } from '@preact/signals';

import { API } from '../api-routes.js';
import { can, csrf } from '../app-state.js';
import { NETWORK_UNREACHABLE, type ApiResult, type Change, type Refused } from '../api.js';
import { request } from '../request.js';
import { itemsOf, readServiceView, type ServiceView } from '../workspace/service-data.js';

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'checking';

export const service: Signal<ServiceView | undefined> = signal(undefined);
export const loadState: Signal<'idle' | 'loading' | 'loaded' | 'missing' | 'error'> = signal('idle');
export const loadRefusal: Signal<Refused | undefined> = signal(undefined);
export const selection: Signal<{ itemId?: string; slideId?: string }> = signal({});
export const saveState: Signal<SaveState> = signal('idle');
export const drift: Signal<readonly { itemId: string; latestRevision: number }[]> = signal([]);
export const rightTab: Signal<'properties' | 'library'> = signal(readRightTab());
export const bulkSelection: Signal<ReadonlySet<string>> = signal(new Set());
export const bulkSelecting: Signal<boolean> = signal(false);
/** Whether leaving selection mode needs confirming: a bulk run is still going, or the Move dialog is open. */
export const bulkBusy: Signal<boolean> = signal(false);
export const pending: Signal<ReadonlySet<string>> = signal(new Set());

/** Whether the workspace must refuse every edit: the service is closed, the client is offline, or the
 *  session was never granted permission to change one in the first place. */
export const isReadOnly: ReadonlySignal<boolean> = computed(() => {
  const state = service.value?.state;
  return state === 'completed' || state === 'archived' || saveState.value === 'offline' || !can('services.manage');
});

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

// An item the service no longer has — removed here, in bulk, by Undo's opposite, or by another client —
// cannot stay selected: the editor and exact preview would point at nothing, and a bulk action would send
// requests for an id the server has already forgotten.
effect(() => {
  const view = service.value;
  if (view === undefined) return;
  const present = new Set(itemsOf(view).map(({ item }) => item.id));
  const selected = selection.peek().itemId;
  if (selected !== undefined && !present.has(selected)) selection.value = {};
  const bulk = [...bulkSelection.peek()];
  if (bulk.some((id) => !present.has(id))) bulkSelection.value = new Set(bulk.filter((id) => present.has(id)));
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

/** Re-fetches the service in the background, without ever moving `loadState` away from `'loaded'` — unlike
 *  `loadService`, a caller such as `useConnection`'s reconnect handler can use this without unmounting
 *  whatever is currently on screen. Leaves `service` untouched on failure and reports whether it worked. */
export async function refreshService(id: string): Promise<boolean> {
  const answer = await request(API.service(id));
  if (!answer.ok) return false;
  const view = readServiceView(answer.data);
  if (view === undefined) return false;
  service.value = view;
  await refreshDrift();
  return true;
}

const PROBE_FIRST_MS = 2000;
const PROBE_MAX_MS = 30_000;
let probe: ReturnType<typeof setTimeout> | undefined;

function stopProbing(): void {
  if (probe !== undefined) clearTimeout(probe);
  probe = undefined;
}

/** After a save could not reach the server, keeps re-reading the service with a doubling back-off until one
 *  answers, then lifts the read-only state. The browser's own `online` event (`useConnection`) never fires
 *  when only the server, a proxy or one request dropped, so waiting for it alone would leave the workspace
 *  frozen until a reload. */
function probeUntilReachable(delayMs = PROBE_FIRST_MS): void {
  stopProbing();
  probe = setTimeout(() => {
    probe = undefined;
    const id = service.value?.id;
    if (id === undefined || saveState.value !== 'offline') return;
    void refreshService(id).then((ok) => {
      if (saveState.value !== 'offline') return;
      if (ok) saveState.value = 'idle';
      else probeUntilReachable(Math.min(delayMs * 2, PROBE_MAX_MS));
    });
  }, delayMs);
}

/** One service write: a fixed `body`, or `bodyFor`, which builds it from the service as it stands the
 *  moment the write actually leaves — after every write queued before it has been answered. */
export type ServiceChange = Omit<Change, 'csrf' | 'body'> & {
  readonly body?: unknown;
  readonly bodyFor?: (current: ServiceView) => unknown;
};

// Every write to the open service goes through this one chain, in order. The server's `edit` replaces the
// whole sections tree, item bodies included, so a section edit or cross-section move built while an
// editor's body save was still in flight would put the old body back; queued, it is built from the answer
// that save produced instead.
let writes: Promise<unknown> = Promise.resolve();

export async function mutate(path: string, change: ServiceChange, pendingId?: string): Promise<ApiResult<ServiceView>> {
  if (pendingId !== undefined) pending.value = new Set(pending.value).add(pendingId);
  saveState.value = 'saving';
  const send = async (): Promise<ApiResult<ServiceView>> => {
    const { bodyFor, ...rest } = change;
    const current = service.value;
    const body = bodyFor === undefined ? rest.body : current === undefined ? undefined : bodyFor(current);
    const answer = await request(path, { ...rest, ...(body === undefined ? {} : { body }), csrf: csrf() ?? '' });
    if (answer.ok) {
      const view = readServiceView(answer.data);
      saveState.value = 'saved';
      if (view !== undefined) {
        service.value = view;
        await refreshDrift();
      }
    } else {
      saveState.value = answer.code === NETWORK_UNREACHABLE ? 'offline' : 'idle';
      if (answer.code === NETWORK_UNREACHABLE) probeUntilReachable();
    }
    return answer as ApiResult<ServiceView>;
  };
  const queued = writes.then(send, send);
  writes = queued.catch(() => undefined);
  try {
    return await queued;
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
  stopProbing();
  service.value = undefined;
  loadState.value = 'idle';
  loadRefusal.value = undefined;
  selection.value = {};
  saveState.value = 'idle';
  drift.value = [];
  rightTab.value = readRightTab();
  bulkSelection.value = new Set();
  bulkSelecting.value = false;
  bulkBusy.value = false;
  pending.value = new Set();
}
