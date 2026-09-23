// How a file reaches the media library. `fetch` reports no upload progress, so this one request goes
// through `XMLHttpRequest` instead, carrying the same client-version and CSRF headers `api.ts` sends and
// read back through the same envelope reader, so an upload's refusal looks like any other. A file the
// server would refuse for its size or type is caught here first, before a single byte is sent.

import { CLIENT_VERSION_HEADER, CLIENT_WINDOW } from '@holydeck/contracts/clients';
import { MEDIA_TYPES } from '@holydeck/contracts/media';
import { CSRF_HEADER } from '@holydeck/contracts/sessions';

import { NETWORK_UNREACHABLE, readEnvelope, UNREADABLE_RESPONSE, type ApiResult } from '../api.js';
import { API } from '../api-routes.js';
import { csrf } from '../app-state.js';
import { applied } from '../request.js';

/** The types the server accepts, read from its own content sniffing list. */
export const ACCEPTED_TYPES: readonly string[] = MEDIA_TYPES;

/** What a file looks like before it is sent: fine, over the size limit, or a type the server refuses. */
export type Precheck = 'ok' | 'too-large' | 'wrong-type';

/**
 * Checks a file's size and declared type against the upload limit and the accepted types. A file the
 * browser gives no type is left for the server, which reads the type from the bytes anyway.
 */
export function precheck(file: File, limitBytes: number, accepted: readonly string[]): Precheck {
  if (file.type !== '' && !accepted.includes(file.type)) return 'wrong-type';
  return file.size > limitBytes ? 'too-large' : 'ok';
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** A byte count in the largest binary unit that keeps it at or above 1, to one decimal place. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

const failed = (code: string, message: string): ApiResult<unknown> => ({ ok: false, code, message, requestId: '', fields: [] });

/** Sends one file as the multipart `file` field, reporting bytes sent as they go. Never rejects. */
export function uploadMedia(file: File, onProgress: (sent: number, total: number) => void): Promise<ApiResult<unknown>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API.mediaUpload);
    xhr.setRequestHeader(CLIENT_VERSION_HEADER, String(CLIENT_WINDOW.current));
    xhr.setRequestHeader(CSRF_HEADER, csrf() ?? '');
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    });
    xhr.addEventListener('load', () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch (error) {
        resolve(failed(UNREADABLE_RESPONSE, error instanceof Error ? error.message : String(error)));
        return;
      }
      resolve(applied(readEnvelope(xhr.status, body)));
    });
    xhr.addEventListener('error', () => resolve(failed(NETWORK_UNREACHABLE, 'the upload never got an answer')));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}
