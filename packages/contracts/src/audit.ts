import { FIELD_CODES, type Parsed, type Problem } from './problems.js';

/** The filters a reader may put around the append-only audit trail, and the bounded page it may take. */
export interface AuditListQuery {
  readonly category?: string;
  readonly action?: string;
  readonly actor?: string;
  readonly outcome?: 'allowed' | 'refused';
  readonly from?: string;
  readonly to?: string;
  readonly cursorAt?: string;
  readonly cursorId?: string;
  readonly limit: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function textField(query: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = query[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * One bound as the store's own `at` is written: a UTC instant with milliseconds, because the store compares
 * it as text and only like compares with like. A bare date is the whole of that day, so a `to` of the
 * 22nd still includes the 22nd. Anything else ISO 8601 does not spell, Date.parse's guesses included, is
 * refused rather than read as some instant nobody typed.
 */
function instantIn(text: string, endOfDay: boolean): string | undefined {
  if (ISO_DATE.test(text)) {
    const day = new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
    // A date that rolls over (the 31st of September) is a date nobody meant, not the 1st of October.
    return !Number.isNaN(day.getTime()) && day.toISOString().startsWith(text) ? day.toISOString() : undefined;
  }
  if (!ISO_INSTANT.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

/** Reads audit filters as text at the boundary, preserving the instant and cursor values the store orders. */
export function parseAuditQuery(
  query: Readonly<Record<string, string | undefined>>,
  path = 'query',
): Parsed<AuditListQuery> {
  const problems: Problem[] = [];

  const category = textField(query, 'category');
  const action = textField(query, 'action');
  const actor = textField(query, 'actor');

  const outcomeRaw = textField(query, 'outcome');
  if (outcomeRaw !== undefined && outcomeRaw !== 'allowed' && outcomeRaw !== 'refused') {
    problems.push({ path: `${path}.outcome`, code: FIELD_CODES.notAllowed, message: 'must be allowed or refused' });
  }

  const fromRaw = textField(query, 'from');
  const from = fromRaw === undefined ? undefined : instantIn(fromRaw, false);
  if (fromRaw !== undefined && from === undefined) {
    problems.push({ path: `${path}.from`, code: FIELD_CODES.notATime, message: 'must be an ISO date or instant' });
  }
  const toRaw = textField(query, 'to');
  const to = toRaw === undefined ? undefined : instantIn(toRaw, true);
  if (toRaw !== undefined && to === undefined) {
    problems.push({ path: `${path}.to`, code: FIELD_CODES.notATime, message: 'must be an ISO date or instant' });
  }

  const cursorAt = textField(query, 'cursorAt');
  const cursorId = textField(query, 'cursorId');
  if ((cursorAt === undefined) !== (cursorId === undefined)) {
    problems.push({
      path: `${path}.cursor`,
      code: FIELD_CODES.notAllowed,
      message: 'cursorAt and cursorId must be given together',
    });
  }

  let limit = DEFAULT_LIMIT;
  const limitRaw = textField(query, 'limit');
  if (limitRaw !== undefined) {
    if (!/^[1-9][0-9]*$/u.test(limitRaw)) {
      problems.push({
        path: `${path}.limit`,
        code: FIELD_CODES.notAWholeNumber,
        message: 'must be a whole number of at least 1',
      });
    } else {
      limit = Number(limitRaw);
      if (limit > MAX_LIMIT) {
        problems.push({ path: `${path}.limit`, code: FIELD_CODES.tooLarge, message: `must be at most ${MAX_LIMIT}` });
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    value: {
      ...(category !== undefined ? { category } : {}),
      ...(action !== undefined ? { action } : {}),
      ...(actor !== undefined ? { actor } : {}),
      ...(outcomeRaw !== undefined ? { outcome: outcomeRaw as 'allowed' | 'refused' } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(cursorAt !== undefined && cursorId !== undefined ? { cursorAt, cursorId } : {}),
      limit,
    },
  };
}
