// A service route gathers the two resources that make its operator workspace useful: an order safe to
// render and a short-lived proof for its live control socket. They are separate on purpose; an unreadable
// order must not keep a live connection from reporting its state, and a browser without sockets still
// receives an honest empty workspace instead of losing the page altogether.

import { LIVE_CONTROL_CHANNEL } from '@holydeck/contracts/live';
import { ORDER_PATH } from '@holydeck/contracts/order';
import { isRecord } from '@holydeck/contracts/problems';
import { TICKET_PATH } from '@holydeck/contracts/sessions';
import { useEffect, useState } from 'preact/hooks';

import { announceConnection, createAnnouncer } from '../announcements.js';
import { csrf, locale } from '../app-state.js';
import { type ControlData, readControlData } from '../components/order-data.js';
import { OrderView } from '../components/order-view.js';
import { t } from '../i18n.js';
import { createLiveClient, detectLiveSocket, type LiveSocketGlobalLike } from '../live-client.js';
import { request } from '../request.js';

import type { JSX } from 'preact';

const emptyOrder: ControlData = { items: [], catalogue: [] };

/** Loads one service's order and owns its live-control session while the route remains mounted. */
export function ServicePage({ id }: { readonly id: string }): JSX.Element {
  const [data, setData] = useState<ControlData>();
  const [connectionStatus, setConnectionStatus] = useState('');

  useEffect(() => {
    let current = true;
    setData(undefined);
    void request(ORDER_PATH).then((answer) => {
      const parsed = answer.ok ? readControlData(answer.data) : undefined;
      if (current) setData(parsed?.ok ? parsed.value : emptyOrder);
    });
    return () => {
      current = false;
    };
  }, [id]);

  useEffect(() => {
    const live = createLiveClient({
      channel: LIVE_CONTROL_CHANNEL,
      origin: globalThis.location?.origin ?? '',
      open: detectLiveSocket(globalThis as LiveSocketGlobalLike),
      credentials: async () => {
        const token = csrf();
        if (token === undefined) return undefined;
        const issued = await request(TICKET_PATH, { method: 'POST', csrf: token });
        if (!issued.ok || !isRecord(issued.data) || typeof issued.data.ticket !== 'string' || issued.data.ticket === '') {
          return undefined;
        }
        return { kind: 'ticket', ticket: issued.data.ticket };
      },
    });
    const stopStatus = live.onStatus((status) => setConnectionStatus(t(`control.connection.${status.state}`)));
    const stopAnnouncements = announceConnection(live, createAnnouncer(document), locale.value);
    void live.connect();
    return () => {
      stopAnnouncements();
      stopStatus();
      live.close();
    };
  }, [id]);

  return data === undefined
    ? <p role="status">{t('app.loading')}</p>
    : <OrderView data={data} serviceId={id} connectionStatus={connectionStatus} />;
}
