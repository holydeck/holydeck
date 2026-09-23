// The Add panel's Media source (WS-08, P-14), and the same list as the Custom Slide canvas's media picker.
// Every upload is listed with its processing state in words beside an icon, because a queued or failed
// upload is still something the person put there; only a ready image or video can be chosen. Inserted,
// a media item pins the upload itself — revision 1 and the hash of its bytes — since media has no history.

import { isRecord, type Parsed } from '@holydeck/contracts/problems';
import { parseMediaManifestEntry, type MediaProcessingState } from '@holydeck/contracts/media';
import { revisionAddress } from '@holydeck/contracts/revisions';
import type { ServiceItem } from '@holydeck/contracts/services';
import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { UNREADABLE_RESPONSE } from '../../api.js';
import { API } from '../../api-routes.js';
import { t } from '../../i18n.js';
import { intrinsicSizeOf } from '../../preview/media-size.js';
import { isReadOnly } from '../../state/workspace-store.js';
import { insertAndSelect, InsertLocation, useInsertTarget } from '../InsertLocation.js';
import { useSource } from './bible-sources.js';
import { NoMatch, SourceError } from './BibleTab.js';

/** One upload as the list shows it. */
export type MediaRow = {
  readonly id: string;
  readonly type: string;
  readonly hash: string;
  readonly state: MediaProcessingState;
  /** Set only for an image or video, the kinds a slide can show. */
  readonly kind?: 'image' | 'video';
};

/** What the canvas receives for a chosen upload. */
export type MediaPick = {
  readonly mediaId: string;
  readonly mediaKind: 'image' | 'video';
  readonly intrinsicSize: { readonly width: number; readonly height: number };
};

const STATE_KEYS: Readonly<Record<MediaProcessingState, MessageKey>> = {
  pending: 'media.state.pending',
  processing: 'media.state.processing',
  ready: 'media.state.ready',
  failed: 'media.state.failed',
};

const STATE_ICONS: Readonly<Record<MediaProcessingState, string>> = { pending: '…', processing: '↻', ready: '✓', failed: '✕' };

const kindOf = (type: string): MediaRow['kind'] =>
  type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : undefined;

/** Media records (`{stamp, manifest}`) as rows; a record whose manifest cannot be read is left out. */
export function readMediaRows(data: unknown): Parsed<readonly MediaRow[]> {
  if (!Array.isArray(data)) return { ok: false, problems: [{ path: 'media', code: UNREADABLE_RESPONSE, message: 'unreadable' }] };
  const rows = data.flatMap((record): MediaRow[] => {
    const parsed = parseMediaManifestEntry(isRecord(record) ? record['manifest'] : undefined, 'media');
    if (!parsed.ok) return [];
    const { id, type, hash, processingState } = parsed.value;
    const kind = kindOf(type);
    return [{ id, type, hash, state: processingState, ...(kind === undefined ? {} : { kind }) }];
  });
  return { ok: true, value: rows };
}

/** The pinned address of an upload's bytes (`sha256:<hex>` becomes `sha256-<hex>`), if it has that form. */
export function mediaAddress(hash: string): string | undefined {
  const digest = /^sha256:([0-9a-f]{8,64})$/u.exec(hash)?.[1];
  return digest === undefined ? undefined : revisionAddress(digest);
}

const choosable = (row: MediaRow): boolean => row.state === 'ready' && row.kind !== undefined;

export interface MediaTabProps {
  /** `insert` adds the chosen upload to the service; `pick` hands it to `onPick` (the canvas). */
  readonly mode?: 'insert' | 'pick';
  readonly query?: string;
  readonly onPick?: (pick: MediaPick) => void;
}

/** The media list with processing states, and Insert or pick for a ready image or video. */
export function MediaTab({ mode = 'insert', query = '', onPick }: MediaTabProps): JSX.Element {
  const [media, retry] = useSource(API.mediaList(), readMediaRows);
  const [chosen, setChosen] = useState<MediaRow | undefined>(undefined);
  const [target, setTarget] = useInsertTarget();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);

  if (media.status === 'loading') return <p role="status">{t('app.loading')}</p>;
  if (media.status === 'error') return <SourceError code={media.code} retry={retry} />;

  const needle = query.trim().toLowerCase();
  const rows = needle === '' ? media.value : media.value.filter((row) => row.id.toLowerCase().includes(needle) || row.type.includes(needle));
  const hintId = `media-not-ready-${mode}`;

  const choose = async (row: MediaRow): Promise<void> => {
    if (!choosable(row) || row.kind === undefined) return;
    setChosen(row);
    if (mode !== 'pick') return;
    setRefusal(undefined);
    try {
      const size = await intrinsicSizeOf(row.id, row.kind);
      onPick?.({ mediaId: row.id, mediaKind: row.kind, intrinsicSize: { width: size.width, height: size.height } });
    } catch {
      setRefusal('media.unreadable');
    }
  };

  const insert = async (): Promise<void> => {
    if (target === undefined || chosen === undefined) return;
    setBusy(true);
    const item: ServiceItem = {
      id: globalThis.crypto.randomUUID(), kind: 'media', title: chosen.id, enabled: true,
      content: { id: chosen.id, revision: 1, hash: mediaAddress(chosen.hash) },
    };
    if (await insertAndSelect(target, item)) setTarget(undefined);
    setBusy(false);
  };

  return (
    <div class="media-tab">
      {media.value.length === 0 ? <p>{t(mode === 'pick' ? 'canvas.media.none' : 'media.initial')}</p>
        : rows.length === 0 ? <NoMatch /> : (
          <ul role="listbox" aria-label={t(mode === 'pick' ? 'canvas.media.pick' : 'media.list')} class="media-list">
            {rows.map((row) => {
              const ready = choosable(row);
              const activate = (): void => void choose(row);
              return (
                <li
                  key={row.id} role="option" tabIndex={0} class="media-row"
                  aria-selected={chosen?.id === row.id} aria-disabled={!ready}
                  aria-describedby={row.state === 'ready' ? undefined : hintId}
                  onClick={activate}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    activate();
                  }}
                >
                  {row.state === 'ready' && row.kind === 'image'
                    ? <img src={API.mediaDerivative(row.id, 'thumbnail')} alt="" width={48} height={27} loading="lazy" />
                    : <span class="media-type">{row.type}</span>}{' '}
                  <span class="media-name truncate" title={row.id}>{row.id}</span>{' '}
                  <span class="media-state"><span aria-hidden="true">{STATE_ICONS[row.state]}</span> {t(STATE_KEYS[row.state])}</span>
                </li>
              );
            })}
          </ul>
        )}
      {rows.some((row) => row.state !== 'ready') ? <p id={hintId}>{t('media.notReady')}</p> : null}
      {refusal === undefined ? null : <p role="alert">{t('add.error')} <code>{refusal}</code></p>}
      {mode === 'insert' ? (
        <>
          <InsertLocation idPrefix="media-insert" value={target} onChange={setTarget} />
          <button type="button" disabled={chosen === undefined || target === undefined || isReadOnly.value || busy} onClick={() => void insert()}>
            {t('add.insert')}
          </button>
        </>
      ) : null}
    </div>
  );
}
