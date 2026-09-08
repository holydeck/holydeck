import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readState, statePath, writeState } from './state.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'holydeck-state-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('state', () => {
  it('computes the state path inside the data dir', () => {
    expect(statePath('/data')).toBe(join('/data', 'state.json'));
  });

  it('round-trips state and creates the data dir', async () => {
    const dataDir = join(dir, 'nested', 'data');
    await writeState(dataDir, { lastSermonFile: '/sermons/2026-09-08.yml' });
    expect(JSON.parse(readFileSync(statePath(dataDir), 'utf8'))).toEqual({
      lastSermonFile: '/sermons/2026-09-08.yml',
    });
    await expect(readState(dataDir)).resolves.toEqual({ lastSermonFile: '/sermons/2026-09-08.yml' });
  });

  it('returns empty state for a missing file', async () => {
    await expect(readState(join(dir, 'nowhere'))).resolves.toEqual({});
  });

  it('returns empty state for corrupt JSON', async () => {
    mkdirSync(join(dir, 'd'));
    writeFileSync(join(dir, 'd', 'state.json'), '{nope');
    await expect(readState(join(dir, 'd'))).resolves.toEqual({});
  });

  it('returns empty state for non-object JSON', async () => {
    mkdirSync(join(dir, 'd2'));
    writeFileSync(join(dir, 'd2', 'state.json'), '"just a string"');
    await expect(readState(join(dir, 'd2'))).resolves.toEqual({});
  });

  it('drops a non-string lastSermonFile', async () => {
    mkdirSync(join(dir, 'd3'));
    writeFileSync(join(dir, 'd3', 'state.json'), '{"lastSermonFile": 42}');
    await expect(readState(join(dir, 'd3'))).resolves.toEqual({});
  });
});
