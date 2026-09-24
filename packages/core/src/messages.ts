export type MessageCode =
  | 'invalid_verse_list'
  | 'invalid_reference'
  | 'unknown_translation'
  | 'invalid_translation'
  | 'sermon_invalid'
  | 'ai_parse_failed'
  | 'ai_api_key_missing'
  | 'ai_request_failed'
  | 'ai_response_invalid'
  | 'sermon_book_unresolved'
  | 'sermon_chapter_out_of_range'
  | 'sermon_verses_unreadable'
  | 'pptx_corrupt'
  | 'pptx_unsupported'
  | 'pptx_empty'
  | 'pptx_too_many_entries'
  | 'pptx_entry_too_large'
  | 'pptx_archive_too_large'
  | 'pptx_unsafe_entry_name'
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
  | 'browser_unavailable'
  | 'scrape_http_error'
  | 'scrape_network_error'
  | 'scrape_parse_failed'
  | 'version_meta_invalid'
  | 'deprecated_env'
  | 'legacy_sermon_format'
  | 'legacy_force_ignored'
  | 'legacy_template'
  | 'sermon_file_missing'
  | 'sermon_file_unreadable'
  | 'sermon_file_forbidden'
  | 'sermon_file_forbidden_cloud'
  | 'no_last_sermon'
  | 'file_exists'
  | 'config_exists'
  | 'server_error'
  | 'server_unreachable'
  | 'server_bad_response'
  | 'auth_failed'
  | 'auth_not_configured'
  | 'local_only_command'
  | 'local_only_option'
  | 'server_admin_token_required'
  | 'unknown_shell'
  | 'deprecated_flag'
  | 'refresh_unchanged'
  | 'cache_footer'
  | 'live_footer'
  | 'fetch_summary'
  | 'canon_unavailable'
  | 'clipboard_unavailable'
  | 'clipboard_read_unavailable'
  | 'copied_to_clipboard'
  | 'confirmation_required'
  | 'write_declined'
  | 'integration_called'
  | 'editor_not_set'
  | 'editor_failed'
  | 'diff_range_invalid'
  | 'request_invalid'
  | 'rate_limit_exceeded'
  | 'route_not_found'
  | 'sync_already_running'
  | 'sync_job_not_found'
  | 'sync_interrupted'
  | 'deprecated_route'
  | 'internal_error';

export const messageCatalog: Record<MessageCode, string> = {
  invalid_verse_list: 'Invalid verse list "{input}". Use comma-separated numbers and ranges, e.g. "1-4,7".',
  invalid_reference:
    'Invalid reference "{input}". Use "<book> <chapter>:<verses>", e.g. "PSA 118:24" or "Genesis 1:5-7,9".',
  unknown_translation: 'Unknown translation "{abbr}". Known: {known}.',
  invalid_translation: 'Invalid translation identifier "{abbr}"; expected 1-16 letters/digits, e.g. "KJV" or "SCH2000".',
  sermon_invalid: 'Invalid sermon file: {reason}.',
  ai_parse_failed: 'Could not turn that message into a sermon file: {reason}.',
  ai_api_key_missing:
    'No key is configured for the book-name resolver, so the book names this build could not place on ' +
    'its own were left as they are; set ANTHROPIC_API_KEY, or add anthropicApiKey to the config file.',
  ai_request_failed:
    'Could not reach the book-name resolver ({reason}), so the book names this build could not place on ' +
    'its own were left as they are.',
  ai_response_invalid:
    'The book-name resolver answered with something this build cannot use ({reason}), so the book names ' +
    'it could not place on its own were left as they are.',
  sermon_book_unresolved:
    'Could not tell which book "{line}" names, so that passage is not in the file; add it by hand.',
  sermon_chapter_out_of_range:
    '"{line}" is past the end of {book}, which has {count} chapter(s), so that passage is not in the file; check the chapter number.',
  sermon_verses_unreadable:
    'Could not read the verses in "{line}", so that passage is not in the file; add it by hand.',
  pptx_corrupt: 'Could not read the PowerPoint file: {reason}.',
  pptx_unsupported: 'This file is not a supported PowerPoint presentation: {reason}.',
  pptx_empty: 'The PowerPoint file has no slides to extract.',
  pptx_too_many_entries: 'The PowerPoint file has too many parts (max {max}).',
  pptx_entry_too_large: 'A part of the PowerPoint file ("{name}") is too large once decompressed (max {max} bytes).',
  pptx_archive_too_large: 'The PowerPoint file is too large once decompressed (max {max} bytes total).',
  pptx_unsafe_entry_name: 'The PowerPoint file has a part with an unsafe name ("{name}").',
  config_invalid_value: 'Invalid value for {key}: "{value}" — {reason}.',
  config_file_unreadable: 'Cannot use config file {path}: {reason}.',
  template_invalid: 'Template error: {reason}.',
  template_index_out_of_range: 'Template references translation index {index} but only {count} translation(s) are configured.',
  chapter_not_in_store: '{abbr} {book} {chapter} is not in the local datastore. Run "holydeck sync {abbr}" first.',
  verse_not_in_store: '{abbr} {book} {chapter}:{verse} is not in the stored chapter (it has {count} verse(s)).',
  revision_not_found: 'Revision {rev} not found for {abbr} {book} {chapter} (available: {available}).',
  store_corrupt: 'Datastore file {path} is corrupt: {reason}.',
  store_newer_schema: 'Datastore file {path} has schema version {found}; this build supports up to {supported}. Update holydeck.',
  store_locked:
    'Datastore for {abbr} is still locked by {owner} after waiting {waitedMs}ms (lock file: {path}). ' +
    'Wait for that run to finish, or delete the lock file if nothing is running.',
  scrape_blocked:
    'bible.com answered with a bot-protection challenge instead of content. Plain HTTP cannot pass it; ' +
    'retry with --browser-fetch (or set browserFetch: true in the config) to fetch through a headless browser.',
  browser_unavailable: 'Could not start the headless browser used to fetch bible.com: {reason}.',
  scrape_http_error: 'bible.com request failed: HTTP {status} for {url}',
  scrape_network_error: 'Could not reach bible.com: {reason} ({url}).',
  scrape_parse_failed: 'No verse content found in the page at {url}. The bible.com markup may have changed.',
  version_meta_invalid: 'Unexpected response from the bible.com version API: {reason}.',
  deprecated_env: 'Environment variable {oldName} is deprecated; use {newName} instead.',
  legacy_sermon_format: 'Sermon file uses the legacy format (version/verses keys); it still works, but switch to "translations" with per-entry "offsets".',
  legacy_force_ignored: 'Legacy "force" flag on {reference} is ignored; use "holydeck sync --refresh" to refetch content.',
  legacy_template: 'Template uses the legacy "{0.field}" syntax; it still works, but Liquid templates are recommended.',
  sermon_file_missing: 'Sermon file {path} does not exist.',
  sermon_file_unreadable: 'Sermon file {path} could not be read: {reason}.',
  sermon_file_forbidden:
    'Sermon file {path} exists but the operating system refused access ({reason}). ' +
    'Check the permissions of the file and of every directory leading to it.',
  sermon_file_forbidden_cloud:
    'Sermon file {path} exists but the operating system refused access ({reason}). ' +
    'It lives in a cloud drive, which macOS guards: the app this command runs in needs Full Disk ' +
    'Access. Grant it in System Settings › Privacy & Security › Full Disk Access, then quit that ' +
    'app and start it again.',
  no_last_sermon: 'No sermon file remembered yet. Run "holydeck get-verses <file>" once; after that --last works.',
  file_exists: 'File {path} already exists; refusing to overwrite.',
  config_exists: 'Config file {path} already exists; pass --force to overwrite it.',
  server_error: 'Server error (HTTP {status}) from {url}: {message}',
  server_unreachable: 'Could not reach the HolyDeck server: {reason} ({url}).',
  server_bad_response: 'Unexpected response from the HolyDeck server at {url}: {reason}.',
  auth_failed: 'Authentication failed: {reason}.',
  auth_not_configured: 'No OIDC login is stored for {url}. Run "holydeck --server-url {url} auth login" first.',
  local_only_command: '"holydeck {command}" works on the local datastore and is not available in server mode (--server-url). Run it where the data lives.',
  local_only_option: '"{option}" is local-only and not available in server mode (--server-url).',
  server_admin_token_required:
    'This command needs the corpus service token (HOLYDECK_SERVER_TOKEN), not a client token — refused by {url}.',
  unknown_shell: 'Unknown shell "{shell}". Supported: zsh, bash.',
  deprecated_flag: 'Flag {oldFlag} is deprecated; use {newFlag} instead.',
  refresh_unchanged: '{abbr} {book} {chapter}: content unchanged, no new revision.',
  cache_footer: 'source: cache · revision {rev} · fetched {date} — {abbr} {book} {chapter}',
  live_footer: 'source: live · revision {rev} · fetched just now — {abbr} {book} {chapter}',
  fetch_summary: 'Fetched {live} of {total} chapters live; --verbose says where each one came from.',
  canon_unavailable: 'Could not fetch the book names of {abbr} ({reason}); rendering its citations with English names.',
  clipboard_unavailable: 'Could not copy to clipboard: no clipboard tool worked (tried {tried}).',
  clipboard_read_unavailable: 'Could not read the clipboard: no clipboard tool worked (tried {tried}).',
  copied_to_clipboard: 'Copied to clipboard.',
  confirmation_required:
    'Nothing is written without a confirmation, and this session has no terminal to ask at. ' +
    'Re-run with --yes to write {path} without being asked.',
  write_declined: 'Nothing was written.',
  integration_called: '{subject}: {outcome} in {durationMs}ms{tokens}.',
  editor_not_set: '$EDITOR is not set; skipping editor launch.',
  editor_failed: 'Editor "{editor}" exited with status {status}.',
  diff_range_invalid: 'Invalid --diff range "{input}". Use two revision numbers like "1..3".',
  request_invalid: 'Invalid request: {reason}.',
  rate_limit_exceeded: 'Rate limit exceeded. Try again later.',
  route_not_found: 'Unknown endpoint: {method} {path}. This response lists the available endpoints.',
  sync_already_running: 'A sync job for {abbr} is already running. Poll GET /api/v1/translations/{abbr}/sync.',
  sync_job_not_found: 'No sync job for {abbr}. Start one with POST /api/v1/translations/{abbr}/sync.',
  sync_interrupted: 'The sync job for {abbr} was interrupted by a server restart. Start it again.',
  deprecated_route: '{oldRoute} is deprecated; use {newRoute} instead.',
  internal_error: 'Unexpected server error.',
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
