// The API's validation paths can name a nested object while a form only knows its own input ids. This
// adapter keeps that server detail at the boundary, returning field messages where a page recognises the
// final segment and one safe, translated message for the remainder a form cannot usefully place itself.

import { NETWORK_UNREACHABLE, type Refused } from './api.js';
import { t } from './i18n.js';

/** Splits a refusal into the field messages one form owns and its one remaining page-level message. */
export function fieldErrors(result: Refused, known: readonly string[]): { byField: Record<string, string>; other: string | undefined } {
  const byField: Record<string, string> = {};
  let other: string | undefined;

  for (const problem of result.fields) {
    const field = problem.path.split('.').at(-1) ?? '';
    if (known.includes(field)) byField[field] = problem.message;
    else if (other === undefined) other = problem.message;
  }

  if (result.fields.length === 0) {
    other = result.code === NETWORK_UNREACHABLE
      ? t('form.error.network')
      : t('form.error.unexpected', { code: result.code });
  }

  return { byField, other };
}
