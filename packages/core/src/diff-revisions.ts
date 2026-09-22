export type RevisionDiffKind = 'added' | 'removed' | 'changed';

export interface RevisionFieldDiff {
  readonly path: string;
  readonly kind: RevisionDiffKind;
  readonly before?: unknown;
  readonly after?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diffAt(path: string, before: unknown, after: unknown, out: RevisionFieldDiff[]): void {
  if (before === after) return;

  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      diffAt(`${path}[${index}]`, before[index], after[index], out);
    }
    return;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) diffAt(path === '' ? key : `${path}.${key}`, before[key], after[key], out);
    return;
  }

  if (before === undefined) {
    out.push({ path, kind: 'added', after });
    return;
  }
  if (after === undefined) {
    out.push({ path, kind: 'removed', before });
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, kind: 'changed', before, after });
}

/**
 * A generic, content-kind-agnostic structural diff over two revision bodies: recurses into nested
 * objects (dotted paths) and index-aligned arrays (bracketed paths). No HTML diffing, no per-kind
 * special-casing — a song's slide array and a sermon's metadata object are both just JSON here.
 */
export function diffRevisions(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): readonly RevisionFieldDiff[] {
  const out: RevisionFieldDiff[] = [];
  diffAt('', before, after, out);
  return Object.freeze(out);
}
