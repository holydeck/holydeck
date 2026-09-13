// What the build leaves behind so anything else can tell whether the client in `dist` is usable.
//
// A watching build in a development stack is the case that needs this: it keeps running after a
// compile error, so "the process is alive" says nothing about whether the code compiles. The stamp
// says, and a health check reads it. Deliberately no freshness rule — a watcher that nobody has given
// anything to build is idle, not broken.

export const BUILD_STAMP = 'build.json';

export interface BuildStamp {
  readonly at: string;
  readonly ok: boolean;
  readonly target: readonly string[];
  readonly problem?: string;
}

export function buildStampText(stamp: BuildStamp): string {
  const { at, ok, target, problem } = stamp;
  return `${JSON.stringify(problem === undefined ? { at, ok, target } : { at, ok, target, problem }, undefined, 2)}\n`;
}

/** Why the built client should not be trusted, or nothing if it should. `undefined` text means no stamp. */
export function buildStampProblem(text: string | undefined): string | undefined {
  if (text === undefined) return 'the web client has not been built yet';

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'the build stamp is not readable';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'the build stamp is not readable';
  }

  const stamp = parsed as Record<string, unknown>;
  if (stamp['ok'] !== true) {
    if (stamp['ok'] !== false) return 'the last build did not finish';
    const problem = stamp['problem'];
    return typeof problem === 'string' && problem !== '' ? `the last build failed: ${problem}` : 'the last build failed';
  }
  if (!Array.isArray(stamp['target']) || stamp['target'].length === 0) {
    return 'the build stamp names no browser target';
  }
  if (typeof stamp['at'] !== 'string' || stamp['at'] === '') return 'the build stamp names no time it was written';
  return undefined;
}
