// The context every repository call carries, instead of reading an ambient global.
//
// Spec 6.4: repositories accept an explicit request context — actor, permissions, correlation
// identifiers. Explicit is the whole point: an ambient current-account is what makes a data layer
// impossible to reason about once there is more than one caller, and impossible to test at all.

export interface RequestContext {
  /** The account or process acting: `account:<id>` for a person, `system` for the product itself. */
  readonly actor: string;
  /** What this actor may do. A repository refuses the call rather than filtering the result. */
  readonly permissions: readonly string[];
  /** Follows one request through every log line and durable record it causes. */
  readonly correlationId: string;
}

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextError';
  }
}

const CORRELATION_ID = /^[A-Za-z0-9:_-]{4,64}$/u;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/**
 * Grades a value that claims to be a context. Separate from building one because a repository is
 * reached from JavaScript too, where the type is a suggestion rather than a guarantee.
 */
export function contextProblems(value: unknown): string[] {
  const candidate = asRecord(value);
  if (candidate === undefined) {
    return ['context: expected an actor, permissions and a correlation identifier'];
  }
  const problems: string[] = [];
  const actor = candidate['actor'];
  if (typeof actor !== 'string' || actor.trim() === '') {
    problems.push('actor: expected the account or process acting');
  }
  const permissions = candidate['permissions'];
  if (!Array.isArray(permissions)) problems.push('permissions: expected a list of names');
  else {
    const seen = new Set<string>();
    for (const permission of permissions) {
      if (typeof permission !== 'string' || permission.trim() === '') {
        problems.push('permissions: expected a list of names');
        break;
      }
      if (seen.has(permission)) {
        problems.push(`permissions: names ${permission} twice`);
        break;
      }
      seen.add(permission);
    }
  }
  const correlationId = candidate['correlationId'];
  if (typeof correlationId !== 'string' || !CORRELATION_ID.test(correlationId)) {
    problems.push('correlationId: expected 4 to 64 characters of letters, digits, colon, dash or underscore');
  }
  return problems;
}

/** Builds a context, refusing one no log could be followed through. */
export function requestContext(input: {
  readonly actor: string;
  readonly permissions: readonly string[];
  readonly correlationId: string;
}): RequestContext {
  const problems = contextProblems(input);
  if (problems.length > 0) throw new ContextError(problems.join('; '));
  return Object.freeze({
    actor: input.actor,
    permissions: Object.freeze([...input.permissions]),
    correlationId: input.correlationId,
  });
}

/** The context the schema work runs under: the product acting as itself, with nothing else granted. */
export function systemContext(correlationId: string): RequestContext {
  return requestContext({
    actor: 'system',
    permissions: ['schemaMigrations.append', 'schemaMigrations.read'],
    correlationId,
  });
}
