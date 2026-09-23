import { parseObject, type Parsed } from './problems.js';

/** The one switch an administrator may change without supplying an integration's private configuration. */
export interface IntegrationPatch {
  readonly enabled: boolean;
}

/** Reads the enabled switch strictly, so a route never mistakes arbitrary request text for consent to run. */
export function parseIntegrationPatch(value: unknown, path = 'body'): Parsed<IntegrationPatch> {
  return parseObject(value, path, (reader) => ({ enabled: reader.flag('enabled') }));
}
