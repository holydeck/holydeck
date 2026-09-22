// The one shape every content route's write path collapses onto: a store either answers or refuses, and
// a refusal is caught here and turned into `{ok:false}` rather than an exception the route has to unwrap
// itself. Extracted from `slide-layout-routes.ts` once a second domain (`service-templates.ts`) needed
// the exact same shape with one more refusal kind — a domain keeps its own error type and the kinds it
// throws, and only the catching itself is shared.

export type Answer<T, K extends string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: K; readonly message: string };

/**
 * Runs a store call and turns a refusal `isRefusal` recognizes into `{ok:false}` rather than letting it
 * escape as an exception. An error `isRefusal` does not recognize — a corrupt record, a bug — is rethrown
 * rather than answered, because it is this server's fault, not the caller's.
 */
export async function settled<T, K extends string>(
  work: () => Promise<T>,
  isRefusal: (error: unknown) => error is Error & { readonly kind: K },
): Promise<Answer<T, K>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (isRefusal(error)) return { ok: false, kind: error.kind, message: error.message };
    throw error;
  }
}

/**
 * The revision half of the same shape: a mutating edit that carries an `expectedRevision` is refused
 * before it is even attempted when that number no longer matches what the store holds, rather than
 * asking `edit` to build a save against a payload the caller read a stale revision for. `undefined`
 * when they still match; otherwise the 409 `ENTITY_CONFLICT` message to answer with, naming the
 * revision actually on file so a caller can re-read it before trying again (songs CRT-03, sermons CRT-05).
 */
export function staleRevision(id: string, expectedRevision: number, currentRevision: number): string | undefined {
  return expectedRevision === currentRevision
    ? undefined
    : `${id} is now at revision ${currentRevision}, not ${expectedRevision}`;
}
