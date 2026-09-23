// The sticky bar selection mode shows: one server request per selected item, run sequentially through
// `runBulk` so two items that touch the same section (a reorder, say) never race each other's answer.
// Move differs from the other four actions: the target section/position is picked once through
// `MoveToDialog`'s `onPick`, then every selected item is moved to it in its own request, reading
// `service.value` fresh before each one so a later item's plan reflects the moves already answered for.

import { useRef, useState } from 'preact/hooks';

import { ENTITY_CONFLICT } from '@holydeck/contracts/http';
import type { JSX } from 'preact';

import { API } from '../api-routes.js';
import type { ApiResult } from '../api.js';
import { t } from '../i18n.js';
import { bulkBusy, bulkSelecting, bulkSelection, isReadOnly, mutate, service } from '../state/workspace-store.js';
import { runBulk, type BulkOutcome } from './bulk-run.js';
import { MoveToDialog } from './MoveToDialog.js';
import { runOrderSteps } from './order-actions.js';
import { beforeAnchor, bulkMoveAnchor, inServiceOrder, reorderPlan } from './order-ops.js';
import { itemsOf, type ServiceView } from './service-data.js';

/** Leaves selection mode, confirming first when a bulk run is still going or the Move dialog is open, so a
 *  stray Done click (or re-clicking Select) never silently drops a run the operator meant to watch finish. */
export function leaveSelectionMode(): void {
  if (bulkBusy.value && !globalThis.confirm(t('bulk.leave.confirm'))) return;
  bulkSelecting.value = false;
  bulkSelection.value = new Set();
}

const asResult = (ok: boolean): ApiResult<unknown> =>
  ok
    ? { ok: true, data: undefined, requestId: '', version: undefined, dropped: undefined }
    : { ok: false, code: ENTITY_CONFLICT, message: '', requestId: '', fields: [] };

export function BulkBar({ view }: { readonly view: ServiceView }): JSX.Element {
  const [moveOpen, setMoveOpen] = useState(false);
  const [outcome, setOutcome] = useState<BulkOutcome | undefined>(undefined);
  const runningRef = useRef(false);

  const readOnly = isReadOnly.value;
  const busy = bulkBusy.value;
  const selectedIds = [...bulkSelection.value];
  const titleById = new Map(itemsOf(view).map(({ item }) => [item.id, item.title]));
  const titleOf = (itemId: string): string => titleById.get(itemId) ?? itemId;

  const run = async (step: (itemId: string) => Promise<ApiResult<unknown>>, ids: readonly string[] = selectedIds): Promise<void> => {
    runningRef.current = true;
    bulkBusy.value = true;
    setOutcome({ done: 0, total: ids.length, refused: [] });
    const result = await runBulk(ids, step, titleOf, setOutcome);
    setOutcome(result);
    runningRef.current = false;
    bulkBusy.value = false;
  };

  const runItemAction = (action: 'enable' | 'disable' | 'duplicate'): void => {
    void run(async (itemId) => mutate(API.itemAction((service.value ?? view).id, itemId, action), { method: 'POST' }, itemId));
  };

  const runRemove = (): void => {
    void run(async (itemId) => mutate(API.item((service.value ?? view).id, itemId), { method: 'DELETE' }, itemId));
  };

  // Each item in service order goes just before the same anchor, so the group arrives in the order it
  // had — not click order, and not reversed by every item being dropped at one fixed index in turn.
  const runMove = (target: { sectionId: string; index: number }): void => {
    const start = service.value ?? view;
    const anchor = bulkMoveAnchor(start, bulkSelection.value, target);
    void run(async (itemId) => {
      const current = service.value ?? view;
      const ok = await runOrderSteps(current.id, itemId, reorderPlan(current, itemId, beforeAnchor(current, itemId, target.sectionId, anchor)));
      return asResult(ok);
    }, inServiceOrder(start, selectedIds));
  };

  const moveItemId = inServiceOrder(service.value ?? view, selectedIds)[0];
  const disableActions = readOnly || busy || selectedIds.length === 0;

  return (
    <div class="bulk-bar" role="region" aria-label={t('bulk.region')}>
      <span>{t('bulk.count', { n: selectedIds.length })}</span>
      <button type="button" disabled={disableActions} onClick={() => { setMoveOpen(true); bulkBusy.value = true; }}>
        {t('order.move.submit')}
      </button>
      <button type="button" disabled={disableActions} onClick={() => runItemAction('duplicate')}>
        {t('order.duplicate')}
      </button>
      <button type="button" disabled={disableActions} onClick={() => runItemAction('enable')}>
        {t('order.enable')}
      </button>
      <button type="button" disabled={disableActions} onClick={() => runItemAction('disable')}>
        {t('order.disable')}
      </button>
      <button type="button" disabled={disableActions} onClick={runRemove}>
        {t('order.remove')}
      </button>
      <button type="button" onClick={leaveSelectionMode}>{t('bulk.done')}</button>
      <div aria-live="polite">
        {outcome === undefined ? null : busy ? (
          <p>{t('bulk.progress', { done: outcome.done, total: outcome.total })}</p>
        ) : outcome.refused.length === 0 ? (
          <p>{t('bulk.result.all', { total: outcome.total })}</p>
        ) : (
          <div>
            <p>{t('bulk.result.partial', { done: outcome.done, total: outcome.total })}</p>
            <ul>
              {outcome.refused.map((entry) => <li key={entry.itemId}>{entry.title}: {entry.reason}</li>)}
            </ul>
          </div>
        )}
      </div>
      {moveOpen && moveItemId !== undefined ? (
        <MoveToDialog
          itemId={moveItemId}
          moving={bulkSelection.value}
          onClose={() => {
            setMoveOpen(false);
            if (!runningRef.current) bulkBusy.value = false;
          }}
          onPick={(target) => runMove(target)}
        />
      ) : null}
    </div>
  );
}
