// Where the Add panel puts a new item. Nothing is inserted by picking content — every tab ends in this
// location plus an explicit Insert (WS-08), and the location starts right after whatever is selected so the
// common case, "add the next thing after this one", needs no choice at all. The server only appends, so a
// place other than the end is two writes: append, then reorder the section with the new item moved.

import type { ServiceItem } from '@holydeck/contracts/services';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import type { ApiResult } from '../api.js';
import { API } from '../api-routes.js';
import { t } from '../i18n.js';
import { mutate, selection, service } from '../state/workspace-store.js';
import { readServiceView, type ServiceView } from './service-data.js';

/** A section and the item the new one follows; no `afterItemId` means the section's end. */
export type InsertTarget = { readonly sectionId: string; readonly afterItemId?: string };

/** Right after the selected item, else the end of the first section; undefined when there is no section. */
export function defaultTarget(view: ServiceView, selectedItemId: string | undefined): InsertTarget | undefined {
  const holding = view.sections.find((section) => section.items.some((item) => item.id === selectedItemId));
  if (holding !== undefined && selectedItemId !== undefined) return { sectionId: holding.id, afterItemId: selectedItemId };
  const first = view.sections[0];
  return first === undefined ? undefined : { sectionId: first.id };
}

/** Appends `item` to the target section and, unless the target is its end, moves it into place. */
export async function insertAt(view: ServiceView, target: InsertTarget, item: ServiceItem): Promise<ApiResult<ServiceView>> {
  const appended = await mutate(API.sectionItems(view.id, target.sectionId), { method: 'POST', body: item });
  if (!appended.ok || target.afterItemId === undefined) return appended;
  // `mutate` answers the stamped record the server sent; only its reading of it is a `ServiceView`.
  const section = readServiceView(appended.data)?.sections.find((entry) => entry.id === target.sectionId);
  const ids = (section?.items ?? []).map((entry) => entry.id).filter((id) => id !== item.id);
  const at = ids.indexOf(target.afterItemId);
  if (at === -1 || at === ids.length - 1) return appended;
  ids.splice(at + 1, 0, item.id);
  return mutate(API.sectionReorder(view.id, target.sectionId), { method: 'POST', body: { itemIds: ids } });
}

/** The location a tab inserts at: the person's own choice while it still names a place in the service,
 *  else the default, which follows the selection — so after an insert (which selects the new item) the next
 *  one lands right after it. Clearing the choice returns to following the selection. */
export function useInsertTarget(): [InsertTarget | undefined, (next: InsertTarget | undefined) => void] {
  const [chosen, setChosen] = useState<InsertTarget | undefined>(undefined);
  const view = service.value;
  if (view === undefined) return [undefined, setChosen];
  const stillThere = chosen !== undefined && view.sections.some((section) => section.id === chosen.sectionId &&
    (chosen.afterItemId === undefined || section.items.some((item) => item.id === chosen.afterItemId)));
  return [stillThere ? chosen : defaultTarget(view, selection.value.itemId), setChosen];
}

/** Inserts and selects the new item, answering whether it landed. */
export async function insertAndSelect(target: InsertTarget, item: ServiceItem): Promise<boolean> {
  const view = service.value;
  if (view === undefined) return false;
  const result = await insertAt(view, target, item);
  if (result.ok) selection.value = { itemId: item.id };
  return result.ok;
}

export interface InsertLocationProps {
  readonly idPrefix: string;
  readonly value: InsertTarget | undefined;
  readonly onChange: (next: InsertTarget) => void;
}

const END = '';

/** The section and position pickers every Add tab ends with. */
export function InsertLocation({ idPrefix, value, onChange }: InsertLocationProps): JSX.Element | null {
  const view = service.value;
  if (view === undefined || value === undefined) return null;
  const section = view.sections.find((entry) => entry.id === value.sectionId) ?? view.sections[0];
  const items = section?.items ?? [];
  return (
    <div class="insert-location">
      <label for={`${idPrefix}-section`}>{t('add.location.section')}</label>
      <select
        id={`${idPrefix}-section`} value={section?.id}
        onChange={(event) => onChange({ sectionId: event.currentTarget.value })}
      >
        {view.sections.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
      </select>
      <label for={`${idPrefix}-position`}>{t('add.location.position')}</label>
      <select
        id={`${idPrefix}-position`} value={value.afterItemId ?? END}
        onChange={(event) => {
          const after = event.currentTarget.value;
          onChange(after === END ? { sectionId: value.sectionId } : { sectionId: value.sectionId, afterItemId: after });
        }}
      >
        {items.map((item) => <option key={item.id} value={item.id}>{t('add.location.after', { title: item.title })}</option>)}
        <option value={END}>{t('add.location.end')}</option>
      </select>
    </div>
  );
}
