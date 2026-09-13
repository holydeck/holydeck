import { describe, expect, it } from 'vitest';

import { REQUIRED_SURFACES, SurfacesNotReachedError, reachLedger } from './reach.js';

import type { Surface } from './reach.js';

describe('the surfaces an integration run has to reach', () => {
  it('names the four the specification requires', () => {
    expect(REQUIRED_SURFACES).toEqual(['application', 'mongo', 'websocket', 'worker']);
  });

  it('counts every surface as missing before anything has run', () => {
    expect(reachLedger().missing()).toEqual([...REQUIRED_SURFACES]);
  });

  it('leaves the other three missing when one is reached', () => {
    const ledger = reachLedger();
    ledger.reached('mongo', 'the ledger records the migration this build needs');
    expect(ledger.missing()).toEqual(['application', 'websocket', 'worker']);
    expect(ledger.detailsFor('mongo')).toEqual(['the ledger records the migration this build needs']);
    // A surface nothing reached has no details rather than no answer: the report prints every surface.
    expect(ledger.detailsFor('worker')).toEqual([]);
  });

  it('keeps every detail recorded against a surface, in the order they happened', () => {
    const ledger = reachLedger();
    ledger.reached('websocket', 'a snapshot arrived');
    ledger.reached('websocket', 'a resume was answered');
    expect(ledger.detailsFor('websocket')).toEqual(['a snapshot arrived', 'a resume was answered']);
  });

  it('has nothing missing once all four are reached', () => {
    const ledger = reachLedger();
    for (const surface of REQUIRED_SURFACES) ledger.reached(surface, `${surface} answered`);
    expect(ledger.missing()).toEqual([]);
    expect(() => ledger.assertEveryRequiredSurface()).not.toThrow();
  });

  // The point of the ledger: a run that quietly exercised three of the four surfaces has to fail, and
  // fail naming the one it never reached, rather than report a suite of passing tests.
  it('refuses a run that never reached a required surface, naming it', () => {
    const ledger = reachLedger();
    ledger.reached('application', 'health answered');
    ledger.reached('mongo', 'the ledger was read');
    let caught: unknown;
    try {
      ledger.assertEveryRequiredSurface();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SurfacesNotReachedError);
    expect((caught as SurfacesNotReachedError).missing).toEqual(['websocket', 'worker']);
    expect((caught as Error).message).toBe(
      'this integration run never reached websocket, worker: a harness that skips a surface proves nothing about it',
    );
  });

  it('refuses a surface it was never asked to require', () => {
    expect(() => reachLedger().reached('printer' as Surface, 'nothing reached this')).toThrow(
      'printer: not a surface this harness requires',
    );
  });

  it('reports what each surface answered, and says so where one answered nothing', () => {
    const ledger = reachLedger();
    ledger.reached('application', 'health answered');
    ledger.reached('mongo', 'the ledger was read');
    ledger.reached('worker', 'the worker called itself healthy');
    expect(ledger.report()).toBe(
      [
        'application: health answered',
        'mongo: the ledger was read',
        'websocket: not reached',
        'worker: the worker called itself healthy',
      ].join('\n'),
    );
  });
});
