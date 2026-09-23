// The Service menu: schedule, duplicate, archive and the one canonical next lifecycle step (ADR 0002).
// Every transition here is server-confirmed, never optimistic — `mutate` only ever applies the answer.

import { useState } from 'preact/hooks';

import { SERVICE_STATES, isCanonicalTransition, type ServiceState } from '@holydeck/contracts/services';
import type { JSX } from 'preact';

import { API } from '../api-routes.js';
import { can, csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { navigate } from '../router.js';
import { mutate } from '../state/workspace-store.js';
import { readServiceView, type ServiceView } from './service-data.js';

const enc = encodeURIComponent;
const CONFIRMED_TARGETS = new Set<ServiceState>(['presenting', 'completed']);

/** The header's Service menu — hidden, not disabled, for a session without `services.manage`. */
export function LifecycleMenu({ view }: { readonly view: ServiceView }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [date, setDate] = useState(view.date);

  if (!can('services.manage')) return null;

  const nextState = SERVICE_STATES.find((candidate) => isCanonicalTransition(view.state, candidate));
  const archived = view.state === 'archived';

  const saveSchedule = async (): Promise<void> => {
    await mutate(API.serviceSchedule(view.id), { method: 'POST', body: { date } });
    setScheduling(false);
    setOpen(false);
  };

  const duplicate = async (): Promise<void> => {
    setOpen(false);
    const result = await request(API.serviceDuplicate(view.id), { method: 'POST', csrf: csrf() ?? '' });
    if (!result.ok) return;
    const copy = readServiceView(result.data);
    if (copy === undefined) return;
    navigate(`/services/${enc(copy.id)}`);
  };

  const toggleArchive = async (): Promise<void> => {
    if (!archived && !globalThis.confirm(t('lifecycle.archive.confirm'))) return;
    setOpen(false);
    await mutate(API.serviceStatus(view.id), { method: 'PATCH', body: { archived: !archived } });
  };

  const moveNext = async (): Promise<void> => {
    if (nextState === undefined) return;
    if (CONFIRMED_TARGETS.has(nextState) && !globalThis.confirm(t('lifecycle.move.confirm', { state: t(`service.state.${nextState}`) }))) return;
    setOpen(false);
    await mutate(API.serviceTransition(view.id), { method: 'POST', body: { state: nextState } });
  };

  return (
    <div class="lifecycle-menu">
      <button type="button" id="lifecycle-menu-opener" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t('lifecycle.menu')}
      </button>
      {open ? (
        <div role="menu" aria-labelledby="lifecycle-menu-opener">
          {view.state === 'upcoming' ? (
            scheduling ? (
              <div>
                <input
                  type="date"
                  aria-label={t('lifecycle.schedule')}
                  value={date}
                  onInput={(event) => setDate(event.currentTarget.value)}
                />
                <button type="button" onClick={() => void saveSchedule()}>{t('lifecycle.schedule.save')}</button>
              </div>
            ) : (
              <button type="button" role="menuitem" onClick={() => setScheduling(true)}>{t('lifecycle.schedule')}</button>
            )
          ) : null}
          <button type="button" role="menuitem" onClick={() => void duplicate()}>{t('lifecycle.duplicate')}</button>
          <button type="button" role="menuitem" onClick={() => void toggleArchive()}>
            {t(archived ? 'lifecycle.unarchive' : 'lifecycle.archive')}
          </button>
          {nextState === undefined ? null : (
            <button type="button" role="menuitem" onClick={() => void moveNext()}>
              {t('lifecycle.move', { state: t(`service.state.${nextState}`) })}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
