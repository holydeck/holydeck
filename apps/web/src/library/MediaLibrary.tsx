// WS-12's Media library at `/media`: every upload with its processing state in words beside an icon, an
// inspect pane with what the manifest records about it, and — for whoever manages media — upload, archive,
// restore and a retry for processing that failed. The manifest keeps no dimensions or duration, so the
// pane says "Not recorded" rather than leaving a gap. Storage health is spec 10's (P-25), not shown here.

import { isRecord, type Parsed } from '@holydeck/contracts/problems';
import { parseMediaManifestEntry, type MediaDerivative, type MediaProcessingState } from '@holydeck/contracts/media';
import type { MessageKey } from '@holydeck/localization/messages';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';

import { UNREADABLE_RESPONSE } from '../api.js';
import { API } from '../api-routes.js';
import { can, csrf } from '../app-state.js';
import { t } from '../i18n.js';
import { request } from '../request.js';
import { useSource } from '../workspace/tabs/bible-sources.js';
import { SourceError } from '../workspace/tabs/BibleTab.js';
import { MediaUpload } from './MediaUpload.js';
import { formatBytes } from './upload.js';

/** One upload as the library shows it. */
export type LibraryMedia = {
  readonly id: string;
  readonly type: string;
  readonly hash: string;
  readonly bytes: number;
  readonly state: MediaProcessingState;
  readonly derivatives: readonly MediaDerivative[];
  readonly archived: boolean;
};

const STATE_KEYS: Readonly<Record<MediaProcessingState, MessageKey>> = {
  pending: 'media.state.pending',
  processing: 'media.state.processing',
  ready: 'media.state.ready',
  failed: 'media.state.failed',
};

const STATE_ICONS: Readonly<Record<MediaProcessingState, string>> = { pending: '…', processing: '↻', ready: '✓', failed: '✕' };

function readOne(record: unknown): LibraryMedia | undefined {
  if (!isRecord(record)) return undefined;
  const parsed = parseMediaManifestEntry(record['manifest'], 'media');
  if (!parsed.ok) return undefined;
  const { id, type, hash, bytes, processingState, derivatives } = parsed.value;
  const stamp = record['stamp'];
  return { id, type, hash, bytes, state: processingState, derivatives, archived: isRecord(stamp) && typeof stamp['archivedAt'] === 'string' };
}

/** Media records (`{stamp, manifest}`); a record whose manifest cannot be read is left out. */
export function readLibraryMedia(data: unknown): Parsed<readonly LibraryMedia[]> {
  if (!Array.isArray(data)) return { ok: false, problems: [{ path: 'media', code: UNREADABLE_RESPONSE, message: 'unreadable' }] };
  return { ok: true, value: data.flatMap((record) => readOne(record) ?? []) };
}

function Inspect({ media, onChanged }: { readonly media: LibraryMedia; readonly onChanged: (next: LibraryMedia | undefined) => void }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const manages = can('media.manage');

  const change = async (path: string, method: 'PATCH' | 'POST', body?: unknown): Promise<void> => {
    setBusy(true);
    setRefusal(undefined);
    const answer = await request(path, { method, csrf: csrf() ?? '', ...(body === undefined ? {} : { body }) });
    setBusy(false);
    if (!answer.ok) {
      setRefusal(answer.code);
      return;
    }
    onChanged(readOne(answer.data));
  };

  const archive = (): void => {
    if (!globalThis.confirm(t('mediaLib.archive.confirm', { name: media.id }))) return;
    void change(API.mediaStatus(media.id), 'PATCH', { archived: true });
  };

  return (
    <section class="media-inspect" aria-labelledby="media-inspect-heading">
      <h2 id="media-inspect-heading" class="truncate" title={media.id}>{media.id}</h2>
      {media.state === 'ready' && media.type.startsWith('image/')
        ? <img src={API.mediaDerivative(media.id, 'thumbnail')} alt="" width={160} height={90} /> : null}
      <dl>
        <dt>{t('mediaLib.type')}</dt><dd>{media.type}</dd>
        <dt>{t('mediaLib.hash')}</dt><dd><code class="truncate" title={media.hash}>{media.hash}</code></dd>
        <dt>{t('mediaLib.size')}</dt><dd>{formatBytes(media.bytes)}</dd>
        <dt>{t('mediaLib.dimensions')}</dt><dd>{t('mediaLib.notRecorded')}</dd>
        <dt>{t('mediaLib.duration')}</dt><dd>{t('mediaLib.notRecorded')}</dd>
        <dt>{t('mediaLib.derivatives')}</dt>
        <dd>
          {media.derivatives.length === 0 ? t('mediaLib.notRecorded') : (
            <ul>{media.derivatives.map((derivative) => <li key={derivative.kind}>{derivative.kind} ({formatBytes(derivative.bytes)})</li>)}</ul>
          )}
        </dd>
      </dl>
      {manages ? (
        <p>
          {media.archived
            ? <button type="button" disabled={busy} onClick={() => void change(API.mediaStatus(media.id), 'PATCH', { archived: false })}>{t('mediaLib.restore')}</button>
            : <button type="button" disabled={busy} onClick={archive}>{t('mediaLib.archive')}</button>}{' '}
          {media.state === 'failed'
            ? <button type="button" disabled={busy} onClick={() => void change(API.mediaRetry(media.id), 'POST')}>{t('mediaLib.retry')}</button> : null}
        </p>
      ) : null}
      {refusal === undefined ? null : <p role="alert">{t('add.error')} <code>{refusal}</code></p>}
    </section>
  );
}

/** The Media library screen: upload, the list with states, and the picked upload's detail. */
export function MediaLibrary(): JSX.Element {
  const manages = can('media.manage');
  const [archived, setArchived] = useState(false);
  const [media, retry] = useSource(API.mediaList(archived), readLibraryMedia);
  const [picked, setPicked] = useState<LibraryMedia | undefined>(undefined);

  const changed = (next: LibraryMedia | undefined): void => {
    if (next !== undefined) setPicked(next);
    retry();
  };

  return (
    <div class="media-library">
      <h1>{t('media.title')}</h1>
      {manages ? <MediaUpload onUploaded={retry} /> : null}
      {manages ? (
        <label>
          <input type="checkbox" checked={archived} onChange={(event) => setArchived(event.currentTarget.checked)} />
          {t('library.archived')}
        </label>
      ) : null}
      {media.status === 'loading' ? <p role="status">{t('app.loading')}</p>
        : media.status === 'error' ? <SourceError code={media.code} retry={retry} />
        : media.value.length === 0 ? <p>{t('canvas.media.none')}</p> : (
          <ul class="media-list" aria-label={t('media.title')}>
            {media.value.map((row) => (
              <li key={row.id}>
                <button type="button" class="media-row" aria-pressed={picked?.id === row.id} onClick={() => setPicked(row)}>
                  {row.state === 'ready' && row.type.startsWith('image/')
                    ? <img src={API.mediaDerivative(row.id, 'thumbnail')} alt="" width={48} height={27} loading="lazy" /> : null}{' '}
                  <span class="media-name truncate" title={row.id}>{row.id}</span>{' '}
                  <span class="media-type">{row.type}</span>{' '}
                  <span>{formatBytes(row.bytes)}</span>{' '}
                  <span class="media-state"><span aria-hidden="true">{STATE_ICONS[row.state]}</span> {t(STATE_KEYS[row.state])}</span>
                  {row.archived ? <span> {t('library.archivedState')}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      {picked === undefined ? null : <Inspect key={picked.id} media={picked} onChanged={changed} />}
    </div>
  );
}
