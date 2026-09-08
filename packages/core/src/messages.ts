export type MessageCode =
  | 'invalid_verse_list'
  | 'invalid_reference'
  | 'unknown_translation'
  | 'invalid_translation'
  | 'sermon_invalid'
  | 'config_invalid_value'
  | 'config_file_unreadable'
  | 'template_invalid'
  | 'template_index_out_of_range'
  | 'chapter_not_in_store'
  | 'verse_not_in_store'
  | 'revision_not_found'
  | 'store_corrupt'
  | 'store_newer_schema'
  | 'store_locked'
  | 'scrape_blocked'
  | 'scrape_http_error'
  | 'scrape_network_error'
  | 'scrape_parse_failed'
  | 'version_meta_invalid'
  | 'deprecated_env'
  | 'legacy_sermon_format'
  | 'legacy_force_ignored'
  | 'legacy_template';

export const messageCatalog: Record<MessageCode, string> = {
  invalid_verse_list: 'Invalid verse list "{input}". Use comma-separated numbers and ranges, e.g. "1-4,7".',
  invalid_reference: 'Invalid reference "{input}". Use "<BOOK> <chapter>:<verses>", e.g. "PSA 118:24" or "GEN 1:5-7,9".',
  unknown_translation: 'Unknown translation "{abbr}". Known: {known}.',
  invalid_translation: 'Invalid translation identifier "{abbr}"; expected 1-16 letters/digits, e.g. "KJV" or "SCH2000".',
  sermon_invalid: 'Invalid sermon file: {reason}.',
  config_invalid_value: 'Invalid value for {key}: "{value}" — {reason}.',
  config_file_unreadable: 'Cannot use config file {path}: {reason}.',
  template_invalid: 'Template error: {reason}.',
  template_index_out_of_range: 'Template references translation index {index} but only {count} translation(s) are configured.',
  chapter_not_in_store: '{abbr} {book} {chapter} is not in the local datastore. Run "holydeck sync {abbr}" first.',
  verse_not_in_store: '{abbr} {book} {chapter}:{verse} is not in the stored chapter (it has {count} verse(s)).',
  revision_not_found: 'Revision {rev} not found for {abbr} {book} {chapter} (available: {available}).',
  store_corrupt: 'Datastore file {path} is corrupt: {reason}.',
  store_newer_schema: 'Datastore file {path} has schema version {found}; this build supports up to {supported}. Update holydeck.',
  store_locked: 'Datastore for {abbr} is locked by another holydeck process (lock file: {path}).',
  scrape_blocked: 'bible.com answered with a bot-protection challenge instead of content. Plain HTTP cannot pass it; try again later or from another network.',
  scrape_http_error: 'bible.com request failed: HTTP {status} for {url}',
  scrape_network_error: 'Could not reach bible.com: {reason} ({url}).',
  scrape_parse_failed: 'No verse content found in the page at {url}. The bible.com markup may have changed.',
  version_meta_invalid: 'Unexpected response from the bible.com version API: {reason}.',
  deprecated_env: 'Environment variable {oldName} is deprecated; use {newName} instead.',
  legacy_sermon_format: 'Sermon file uses the legacy format (version/verses keys); it still works, but switch to "translations" with per-entry "offsets".',
  legacy_force_ignored: 'Legacy "force" flag on {reference} is ignored; use "holydeck sync --refresh" to refetch content.',
  legacy_template: 'Template uses the legacy "{0.field}" syntax; it still works, but Liquid templates are recommended.',
};

export function formatMessage(code: MessageCode, params: Record<string, string | number> = {}): string {
  return messageCatalog[code].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

export class HolyDeckError extends Error {
  readonly code: MessageCode;
  readonly params: Record<string, string | number>;

  constructor(code: MessageCode, params: Record<string, string | number> = {}) {
    super(formatMessage(code, params));
    this.name = 'HolyDeckError';
    this.code = code;
    this.params = params;
  }
}
