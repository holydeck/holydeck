import { describe, expect, it } from 'vitest';

import { BUILD_STAMP, buildStampProblem, buildStampText } from './build-stamp.js';

const AT = '2026-09-13T09:00:00.000Z';
const target = ['chrome131', 'safari18'];

describe('where the stamp lives', () => {
  it('is a file inside the built client, so whatever serves the client can see it', () => {
    expect(BUILD_STAMP).toBe('build.json');
  });
});

describe('what a build writes', () => {
  it('records when it ran, whether it worked, and what it built for', () => {
    expect(JSON.parse(buildStampText({ at: AT, ok: true, target }))).toEqual({ at: AT, ok: true, target });
  });

  it('records why a build failed, so the health check can say it out loud', () => {
    expect(JSON.parse(buildStampText({ at: AT, ok: false, target, problem: 'main.ts:3 unexpected }' }))).toEqual({
      at: AT,
      ok: false,
      target,
      problem: 'main.ts:3 unexpected }',
    });
  });

  it('leaves the reason out when there is none', () => {
    expect(Object.keys(JSON.parse(buildStampText({ at: AT, ok: true, target })))).toEqual(['at', 'ok', 'target']);
  });

  it('ends with a newline', () => {
    expect(buildStampText({ at: AT, ok: true, target }).endsWith('\n')).toBe(true);
  });

  it('writes what the health check reads, with nothing between them to disagree about', () => {
    expect(buildStampProblem(buildStampText({ at: AT, ok: true, target }))).toBeUndefined();
  });
});

describe('judging a stamp', () => {
  it('refuses a client that was never built', () => {
    expect(buildStampProblem(undefined)).toBe('the web client has not been built yet');
  });

  it('refuses a stamp that is not readable', () => {
    expect(buildStampProblem('{ half written')).toBe('the build stamp is not readable');
  });

  it('refuses a stamp that is readable but is not a record', () => {
    expect(buildStampProblem('[]')).toBe('the build stamp is not readable');
  });

  it('refuses a stamp that does not say the build worked, rather than assuming it did', () => {
    expect(buildStampProblem('{"at":"2026-09-13T09:00:00.000Z","target":["chrome131"]}')).toBe(
      'the last build did not finish',
    );
  });

  it('reports the failure the build recorded, which is the whole point of a watching build', () => {
    expect(buildStampProblem(buildStampText({ at: AT, ok: false, target, problem: 'main.ts:3 unexpected }' }))).toBe(
      'the last build failed: main.ts:3 unexpected }',
    );
  });

  it('says a build failed even when it recorded no reason', () => {
    expect(buildStampProblem('{"at":"2026-09-13T09:00:00.000Z","ok":false,"target":["chrome131"]}')).toBe(
      'the last build failed',
    );
  });

  it('refuses a stamp that names no browser target, because that is not a build this repository makes', () => {
    expect(buildStampProblem('{"at":"2026-09-13T09:00:00.000Z","ok":true,"target":[]}')).toBe(
      'the build stamp names no browser target',
    );
  });

  it('refuses a stamp whose target is not a list', () => {
    expect(buildStampProblem('{"at":"2026-09-13T09:00:00.000Z","ok":true,"target":"chrome131"}')).toBe(
      'the build stamp names no browser target',
    );
  });

  it('refuses a stamp that names no time it was written', () => {
    expect(buildStampProblem('{"ok":true,"target":["chrome131"]}')).toBe('the build stamp names no time it was written');
  });
});
