// The one place a workspace remembers where an account was looking, so reopening a service resumes there
// instead of starting over at the top of the order (SERV-01). This never edits the service itself and
// never sends a live command (WS-02): resuming a position is a per-account convenience the room never
// learns about, which is why it goes through `request` rather than `mutate` in `workspace-store.ts`.

import { effect } from '@preact/signals';

import { isRecord } from '@holydeck/contracts/problems';
import { parseWorkspacePosition, type WorkspacePosition } from '@holydeck/contracts/workspace';

import { API } from '../api-routes.js';
import { csrf } from '../app-state.js';
import { request } from '../request.js';
import { selection, service } from '../state/workspace-store.js';

const DEBOUNCE_MS = 2000;

const samePosition = (a: WorkspacePosition, b: WorkspacePosition): boolean =>
  a.serviceId === b.serviceId && a.itemId === b.itemId && a.slideId === b.slideId;

/**
 * Starts writing the current service and selection to the server, 2000 ms debounced, skipping a position
 * identical to the last one actually sent. Returns a disposer that cancels a pending write and stops
 * tracking the signals.
 */
export function startPositionWriter(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: WorkspacePosition | undefined;

  const stop = effect(() => {
    const current = service.value;
    if (current === undefined) return;
    const { itemId, slideId } = selection.value;
    const position: WorkspacePosition = {
      serviceId: current.id,
      ...(itemId === undefined ? {} : { itemId }),
      ...(slideId === undefined ? {} : { slideId }),
    };

    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (last !== undefined && samePosition(last, position)) return;
      last = position;
      void request(API.workspacePosition, { method: 'PUT', csrf: csrf() ?? '', body: position });
    }, DEBOUNCE_MS);
  });

  return (): void => {
    if (timer !== undefined) clearTimeout(timer);
    stop();
  };
}

/** Reads the account's stored position, and which of its fields the server dropped as no longer valid. */
export async function readPosition(): Promise<{ position?: WorkspacePosition; dropped: readonly string[] }> {
  const answer = await request(API.workspacePosition);
  const dropped = answer.ok && Array.isArray(answer.dropped) ? answer.dropped : [];
  if (!answer.ok || !isRecord(answer.data)) return { dropped };
  const parsed = parseWorkspacePosition(answer.data['position']);
  return parsed.ok ? { position: parsed.value, dropped } : { dropped };
}
