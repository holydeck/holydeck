import { parseObject, type Parsed, type ParseFn } from './problems.js';

/** The one switch an administrator may change without supplying an integration's private configuration. */
export interface IntegrationPatch {
  readonly enabled: boolean;
}

/** Reads the enabled switch strictly, so a route never mistakes arbitrary request text for consent to run. */
export const parseIntegrationPatch: ParseFn<IntegrationPatch> & ((value: unknown) => Parsed<IntegrationPatch>) = (value, path: string = 'body') =>
  parseObject(value, path, (reader) => ({ enabled: reader.flag('enabled') }));
