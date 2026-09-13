// The ledger an integration run is graded by.
//
// A harness that starts a whole stack and then only ever talks to one part of it looks exactly like a
// harness that talks to all of it: green, fast, and silent about the surface nobody touched. So every
// surface records the fact that it answered, and the run fails at the end if one of them never did.
// The list is the specification's, not this file's invention: the integration layer exercises the
// same-origin application, worker jobs, a WebSocket client and MongoDB.

export const REQUIRED_SURFACES = ['application', 'mongo', 'websocket', 'worker'] as const;

export type Surface = (typeof REQUIRED_SURFACES)[number];

const NOT_REACHED = 'not reached';

export class SurfacesNotReachedError extends Error {
  readonly missing: readonly Surface[];

  constructor(missing: readonly Surface[]) {
    super(
      `this integration run never reached ${missing.join(', ')}: ` +
        'a harness that skips a surface proves nothing about it',
    );
    this.name = 'SurfacesNotReachedError';
    this.missing = missing;
  }
}

export interface ReachLedger {
  /** Records that a surface answered, with what it answered, so the report says more than "yes". */
  reached(surface: Surface, detail: string): void;
  detailsFor(surface: Surface): readonly string[];
  missing(): readonly Surface[];
  assertEveryRequiredSurface(): void;
  report(): string;
}

export function reachLedger(): ReachLedger {
  const details = new Map<Surface, string[]>();

  const ledger: ReachLedger = {
    reached(surface, detail) {
      // A typo in a surface name would otherwise record a reach nothing grades, which is the one failure
      // mode a ledger must not have: it would read as covered while the real surface went untouched.
      if (!REQUIRED_SURFACES.includes(surface)) {
        throw new Error(`${surface}: not a surface this harness requires`);
      }
      const recorded = details.get(surface);
      if (recorded === undefined) details.set(surface, [detail]);
      else recorded.push(detail);
    },
    detailsFor(surface) {
      return details.get(surface) ?? [];
    },
    missing() {
      return REQUIRED_SURFACES.filter((surface) => !details.has(surface));
    },
    assertEveryRequiredSurface() {
      const missing = ledger.missing();
      if (missing.length > 0) throw new SurfacesNotReachedError(missing);
    },
    report() {
      return REQUIRED_SURFACES.map((surface) => {
        const recorded = details.get(surface);
        return `${surface}: ${recorded === undefined ? NOT_REACHED : recorded.join('; ')}`;
      }).join('\n');
    },
  };

  return ledger;
}
