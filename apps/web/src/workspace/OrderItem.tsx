// One row in the Order panel: how an item is identified, reordered and acted on. Every action waits for
// the server's answer before the row moves — `service.value` is the only source of order, never an
// optimistic guess — so a slow or refused request never shows a position nothing has confirmed.

import { useRef, useState } from 'preact/hooks';

import type { ServiceItem } from '@holydeck/contracts/services';
import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';

import { showToast } from '../components/toast.js';
import { t } from '../i18n.js';
import { Thumbnail } from '../preview/Thumbnail.js';
import { bulkSelecting, bulkSelection, isReadOnly, mutate, pending, service } from '../state/workspace-store.js';
import { API } from '../api-routes.js';
import { DriftNotice } from './DriftNotice.js';
import { MoveToDialog } from './MoveToDialog.js';
import { runOrderSteps } from './order-actions.js';
import { moveWithin, neighbours, reorderPlan, type Neighbours } from './order-ops.js';
import { itemsOf } from './service-data.js';

const KIND_KEY: Record<ServiceItem['kind'], MessageKey> = {
  song: 'order.kind.song',
  sermon: 'order.kind.sermon',
  reading: 'order.kind.reading',
  media: 'order.kind.media',
  'slide-group': 'order.kind.slideGroup',
  'custom-slide': 'order.kind.customSlide',
};

/** Re-adds `snapshot` to `sectionId` and reorders it back to `atIndex` — the Undo half of Remove. */
async function undoRemove(serviceId: string, sectionId: string, atIndex: number, snapshot: ServiceItem): Promise<void> {
  const added = await mutate(API.sectionItems(serviceId, sectionId), {
    method: 'POST',
    body: {
      id: snapshot.id, kind: snapshot.kind, title: snapshot.title, enabled: snapshot.enabled,
      content: snapshot.content, ...(snapshot.body === undefined ? {} : { body: snapshot.body }),
    },
  }, snapshot.id);
  if (!added.ok) return;
  const restored = service.value?.sections.find((candidate) => candidate.id === sectionId);
  if (restored === undefined) return;
  const itemIds = moveWithin(restored.items.map((item) => item.id), snapshot.id, atIndex);
  await mutate(API.sectionReorder(serviceId, sectionId), { method: 'POST', body: { itemIds } }, snapshot.id);
}

export function OrderItem({ sectionId, item, index }: {
  readonly sectionId: string;
  readonly item: ServiceItem;
  readonly index: number;
  readonly total: number;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveToOpen, setMoveToOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const actionsRef = useRef<HTMLButtonElement>(null);

  const readOnly = isReadOnly.value;
  const busy = pending.value.has(item.id);
  const view = service.value;
  const present = view !== undefined && itemsOf(view).some(({ item: candidate }) => candidate.id === item.id);

  // The server has already confirmed this item's removal and `service.value` no longer names it; its
  // parent is about to stop rendering this row too, so there is nothing left here to show in the meantime.
  if (view !== undefined && !present) return <></>;

  const at: Partial<Neighbours> = view === undefined ? {} : neighbours(view, item.id);

  const move = (target: { sectionId: string; index: number }): void => {
    if (view === undefined) return;
    void runOrderSteps(view.id, item.id, reorderPlan(view, item.id, target));
  };

  const toggleSelected = (): void => {
    const next = new Set(bulkSelection.value);
    if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
    bulkSelection.value = next;
  };

  const runAction = (action: 'enable' | 'disable' | 'duplicate'): void => {
    setMenuOpen(false);
    if (view === undefined) return;
    void mutate(API.itemAction(view.id, item.id, action), { method: 'POST' }, item.id);
  };

  const remove = async (): Promise<void> => {
    setMenuOpen(false);
    if (view === undefined) return;
    const serviceId = view.id;
    const fromSectionId = sectionId;
    const atIndex = index;
    const snapshot = item;
    const result = await mutate(API.item(serviceId, item.id), { method: 'DELETE' }, item.id);
    if (!result.ok) return;
    showToast({
      message: t('order.removed'),
      action: {
        label: t('order.undo'),
        run: () => void undoRemove(serviceId, fromSectionId, atIndex, snapshot),
      },
    });
  };

  return (
    <li id={`workspace-item-${item.id}`} class="order-item" aria-busy={busy ? 'true' : undefined} data-item-id={item.id}>
      {bulkSelecting.value ? (
        <input
          type="checkbox"
          aria-label={t('bulk.item', { title: item.title })}
          checked={bulkSelection.value.has(item.id)}
          onChange={toggleSelected}
        />
      ) : null}
      <button
        type="button"
        aria-label={t('order.drag', { title: item.title })}
        draggable={!readOnly}
        disabled={readOnly}
        onDragStart={(event) => event.dataTransfer?.setData('text/plain', item.id)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' && at.up !== undefined) {
            event.preventDefault();
            move({ sectionId, index: at.up });
          } else if (event.key === 'ArrowDown' && at.down !== undefined) {
            event.preventDefault();
            move({ sectionId, index: at.down });
          }
        }}
      >
        ⠿
      </button>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {t('order.expand', { title: item.title })}
      </button>
      <span title={item.title}>{item.title}</span>
      <span>{t(KIND_KEY[item.kind])}</span>
      {item.content === undefined ? null : <span>{t('order.revision', { n: item.content.revision })}</span>}
      <DriftNotice itemId={item.id} />
      {item.enabled ? null : <span class="is-disabled">{t('order.disabled')}</span>}
      {busy ? <span class="order-item-pending" aria-hidden="true" /> : null}
      <div class="order-item-actions">
        <button
          type="button"
          ref={actionsRef}
          id={`order-actions-${item.id}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={readOnly}
          onClick={() => setMenuOpen(!menuOpen)}
        >
          {t('order.actions', { title: item.title })}
        </button>
        {menuOpen ? (
          <div role="menu" aria-labelledby={`order-actions-${item.id}`}>
            <button type="button" role="menuitem" disabled={readOnly} onClick={() => runAction(item.enabled ? 'disable' : 'enable')}>
              {t(item.enabled ? 'order.disable' : 'order.enable')}
            </button>
            <button type="button" role="menuitem" disabled={readOnly} onClick={() => runAction('duplicate')}>
              {t('order.duplicate')}
            </button>
            <button
              type="button" role="menuitem" disabled={readOnly || at.up === undefined}
              onClick={() => { setMenuOpen(false); if (at.up !== undefined) move({ sectionId, index: at.up }); }}
            >
              {t('order.moveUp')}
            </button>
            <button
              type="button" role="menuitem" disabled={readOnly || at.down === undefined}
              onClick={() => { setMenuOpen(false); if (at.down !== undefined) move({ sectionId, index: at.down }); }}
            >
              {t('order.moveDown')}
            </button>
            <button type="button" role="menuitem" disabled={readOnly} onClick={() => { setMenuOpen(false); setMoveToOpen(true); }}>
              {t('order.moveTo')}
            </button>
            <button type="button" role="menuitem" disabled={readOnly} onClick={() => void remove()}>
              {t('order.remove')}
            </button>
          </div>
        ) : null}
      </div>
      {expanded ? <div data-slot="thumbnails"><Thumbnail itemId={item.id} /></div> : null}
      {moveToOpen ? (
        <MoveToDialog
          itemId={item.id}
          onClose={() => {
            setMoveToOpen(false);
            actionsRef.current?.focus();
          }}
        />
      ) : null}
    </li>
  );
}
