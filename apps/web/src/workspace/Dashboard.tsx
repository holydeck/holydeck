// Where a signed-in account lands: the service it is presenting or about to prepare, the position it left
// off at, and everything else recent enough to matter. `Workspace` (Task 13) owns a service once opened;
// this page only ever reads the list and current-service facts that decide what to open next.

import { useEffect, useState } from 'preact/hooks';

import type { WorkspacePosition } from '@holydeck/contracts/workspace';
import type { JSX } from 'preact';

import { NETWORK_UNREACHABLE } from '../api.js';
import { API } from '../api-routes.js';
import { can, locale } from '../app-state.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { ContinueCard } from './ContinueCard.js';
import { nextService } from './next-service.js';
import { recallAnswer, rememberAnswer } from './offline-cache.js';
import { readPosition } from './position-writer.js';
import { readServiceList, readServiceView, type ServiceView } from './service-data.js';

const enc = encodeURIComponent;
const SERVICES_CACHE_KEY = 'services';

type LoadOutcome =
  | { readonly status: 'loaded'; readonly services: readonly ServiceView[]; readonly offlineSince?: undefined }
  | { readonly status: 'offline'; readonly services: readonly ServiceView[]; readonly offlineSince: string }
  | { readonly status: 'error' };

const today = (): string => new Date().toISOString().slice(0, 10);

const dateOf = (view: ServiceView): string =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${view.date}T00:00:00Z`));

const timeOf = (at: string): string => new Intl.DateTimeFormat(locale.value, { timeStyle: 'short' }).format(new Date(at));

function NextServiceCard({ view }: { readonly view: ServiceView }): JSX.Element {
  return (
    <>
      <h3>{view.title}</h3>
      <p>{dateOf(view)}</p>
      <p>{view.site}</p>
      <p>{t(`service.state.${view.state}`)}</p>
      <p>{t('dashboard.readiness.later')}</p>
      <p>
        <a class="button accent" href={`/services/${enc(view.id)}/readiness`}>{t('dashboard.prepare')}</a>{' '}
        <a href={`/services/${enc(view.id)}`}>{t('dashboard.edit')}</a>{' '}
        <a href={`/services/${enc(view.id)}/readiness?intent=present`}>{t('dashboard.present')}</a>
      </p>
    </>
  );
}

function RecentList({ services, showArchived, onShowArchived }: {
  readonly services: readonly ServiceView[];
  readonly showArchived: boolean;
  readonly onShowArchived: (next: boolean) => void;
}): JSX.Element {
  const visible = services
    .filter((view) => showArchived || view.state !== 'archived')
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));

  return (
    <section aria-labelledby="dashboard-recent-heading">
      <h2 id="dashboard-recent-heading">{t('dashboard.recent')}</h2>
      <label>
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => onShowArchived(event.currentTarget.checked)}
        />
        {t('dashboard.showArchived')}
      </label>
      <ul>
        {visible.map((view) => (
          <li key={view.id}>
            <a href={`/services/${enc(view.id)}`}>{view.title}</a> {t(`service.state.${view.state}`)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The services landing page: the account's last position, what is next, and everything recent. */
export function Dashboard(): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [outcome, setOutcome] = useState<LoadOutcome>({ status: 'loaded', services: [] });
  const [presenting, setPresenting] = useState<ServiceView | undefined>(undefined);
  const [position, setPosition] = useState<WorkspacePosition | undefined>(undefined);
  const [dropped, setDropped] = useState<readonly string[]>([]);
  const [showArchived, setShowArchived] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    const [positionResult, currentAnswer, listAnswer] = await Promise.all([
      readPosition(),
      request(API.serviceCurrent),
      request(API.services),
    ]);

    setPosition(positionResult.position);
    setDropped(positionResult.dropped);
    setPresenting(currentAnswer.ok ? readServiceView(currentAnswer.data) : undefined);

    if (listAnswer.ok) {
      const list = readServiceList(listAnswer.data) ?? [];
      rememberAnswer(SERVICES_CACHE_KEY, list);
      setOutcome({ status: 'loaded', services: list });
    } else if (listAnswer.code === NETWORK_UNREACHABLE) {
      const cached = recallAnswer(SERVICES_CACHE_KEY);
      setOutcome(cached === undefined
        ? { status: 'error' }
        : { status: 'offline', services: cached.value as readonly ServiceView[], offlineSince: cached.at });
    } else {
      setOutcome({ status: 'error' });
    }

    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  if (loading) {
    return (
      <div aria-busy="true">
        <h1>{t('dashboard.title')}</h1>
        <p role="status">{t('app.loading')}</p>
      </div>
    );
  }

  if (outcome.status === 'error') {
    return (
      <div>
        <h1>{t('dashboard.title')}</h1>
        <p role="alert">{t('workspace.load.error')}</p>
        <button type="button" onClick={() => void load()}>{t('workspace.load.retry')}</button>
      </div>
    );
  }

  const services = outcome.services;
  const next = presenting ?? nextService(services, today());
  const empty = presenting === undefined && next === undefined && services.length === 0;

  return (
    <div>
      <h1>{t('dashboard.title')}</h1>
      {outcome.status === 'offline'
        ? <p role="status">{t('dashboard.offline', { time: timeOf(outcome.offlineSince) })}</p>
        : null}
      <ContinueCard
        position={position}
        dropped={dropped}
        titleOf={(serviceId) => services.find((view) => view.id === serviceId)?.title ?? presenting?.title}
      />
      {empty ? (
        <div>
          <h2>{t('dashboard.empty.heading')}</h2>
          <p>{t('dashboard.empty.body')}</p>
        </div>
      ) : (
        <>
          <section aria-labelledby="dashboard-next-heading">
            <h2 id="dashboard-next-heading">{t('dashboard.next')}</h2>
            {next === undefined ? null : <NextServiceCard view={next} />}
          </section>
          <RecentList services={services} showArchived={showArchived} onShowArchived={setShowArchived} />
        </>
      )}
      {can('services.manage') ? <p><a href="/services/new">{t('dashboard.new')}</a></p> : null}
    </div>
  );
}
