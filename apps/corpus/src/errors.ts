import type { HolyDeckError, MessageCode } from '@holydeck/core/messages';

export const API_ENDPOINTS: Record<string, string> = {
  'GET /health': 'liveness + store connectivity',
  'GET /api/v1/translations': 'list known and cached translations',
  'GET /api/v1/translations/:abbr/canon': 'book/chapter structure for a translation',
  'GET /api/v1/translations/:abbr/verses': 'read verses: ?book=GEN&chapter=1&verses=1-3[&refresh][&revision=N]',
  'POST /api/v1/translations/:abbr/sync': 'start a background sync job',
  'GET /api/v1/translations/:abbr/sync': 'status of the latest sync job',
  'GET /api/v1/stats': 'datastore statistics',
  'POST /api/v1/render': 'render a sermon file (YAML or JSON body) to text',
};

const STATUS_BY_CODE: Partial<Record<MessageCode, number>> = {
  invalid_verse_list: 400,
  invalid_reference: 400,
  sermon_invalid: 400,
  config_invalid_value: 400,
  config_file_unreadable: 400,
  template_invalid: 400,
  template_index_out_of_range: 400,
  request_invalid: 400,
  rate_limit_exceeded: 429,
  unknown_translation: 404,
  chapter_not_in_store: 404,
  verse_not_in_store: 404,
  revision_not_found: 404,
  sync_job_not_found: 404,
  route_not_found: 404,
  store_locked: 409,
  sync_already_running: 409,
  scrape_blocked: 502,
  scrape_http_error: 502,
  scrape_network_error: 502,
  scrape_parse_failed: 502,
  version_meta_invalid: 502,
};

export function statusForCode(code: MessageCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

export interface ErrorEnvelope {
  error: { code: MessageCode; message: string };
}

export function errorEnvelope(error: HolyDeckError): ErrorEnvelope {
  return { error: { code: error.code, message: error.message } };
}
