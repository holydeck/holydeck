// Where an item goes when Move To… is chosen: one section select and one position select, computed from
// whichever section is currently picked so a move that stays in its own section still offers that
// section's own last position rather than counting the item twice. Escape and Cancel both hand focus back
// to the Actions button that opened this, the same as answering Move does.
//
// happy-dom's <dialog> does not fire `cancel`/`close` on its own, so Escape is handled by hand here
// (`onKeyDown`) rather than relying on the platform event a real browser would also raise.

import { useEffect, useRef, useState } from 'preact/hooks';

import type { JSX } from 'preact';

import { t } from '../i18n.js';
import { service } from '../state/workspace-store.js';
import { runOrderSteps } from './order-actions.js';
import { neighbours, reorderPlan } from './order-ops.js';

export function MoveToDialog({ itemId, onClose, onPick }: {
  readonly itemId: string;
  readonly onClose: () => void;
  /** When given, picking a target reports it here instead of moving `itemId` itself — a bulk run uses
   *  this to collect one target and then move each selected item to it in turn. */
  readonly onPick?: (target: { sectionId: string; index: number }) => void;
}): JSX.Element | null {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const view = service.value;
  const located = view === undefined ? undefined : neighbours(view, itemId);
  const [sectionId, setSectionId] = useState(located?.sectionId ?? '');
  const [index, setIndex] = useState(located?.index ?? 0);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
    firstFieldRef.current?.focus();
  }, []);

  if (view === undefined || located === undefined) return null;

  const section = view.sections.find((candidate) => candidate.id === sectionId);
  const positions = (section?.items ?? []).filter((candidate) => candidate.id !== itemId).length + 1;

  const submit = async (event: JSX.TargetedEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (onPick !== undefined) {
      onPick({ sectionId, index });
      onClose();
      return;
    }
    setSubmitting(true);
    await runOrderSteps(view.id, itemId, reorderPlan(view, itemId, { sectionId, index }));
    setSubmitting(false);
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('order.moveTo')}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <label>
          {t('order.move.section')}
          <select
            ref={firstFieldRef}
            value={sectionId}
            onChange={(event) => {
              setSectionId(event.currentTarget.value);
              setIndex(0);
            }}
          >
            {view.sections.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label>
        <label>
          {t('order.move.position')}
          <select value={String(index)} onChange={(event) => setIndex(Number(event.currentTarget.value))}>
            {Array.from({ length: positions }, (_, position) => (
              <option key={position} value={String(position)}>{position + 1}</option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={submitting}>{t('order.move.submit')}</button>
        <button type="button" onClick={onClose}>{t('order.move.cancel')}</button>
      </form>
    </dialog>
  );
}
