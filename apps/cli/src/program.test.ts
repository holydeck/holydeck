import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { HolyDeckError } from '@holydeck/core/messages';
import { makeContext, seedStore } from '../test/harness.js';
import { reportError, runCli } from './program.js';
import { CLI_VERSION } from './version.js';

describe('runCli', () => {
  it('prints the version', async () => {
    const { ctx, stdout } = makeContext();
    await expect(runCli(ctx, ['--version'])).resolves.toBe(0);
    expect(stdout()).toContain(CLI_VERSION);
  });

  it('prints help with exit code 0', async () => {
    const { ctx, stdout } = makeContext();
    await expect(runCli(ctx, ['--help'])).resolves.toBe(0);
    expect(stdout()).toContain('holydeck');
    expect(stdout()).toContain('--data-dir');
    expect(stdout()).toContain('--server-url');
    expect(stdout()).toContain('--json');
  });

  it('reports unknown commands on stderr with exit code 1', async () => {
    const { ctx, stderr } = makeContext();
    await expect(runCli(ctx, ['definitely-not-a-command'])).resolves.toBe(1);
    expect(stderr()).toContain('definitely-not-a-command');
  });

  it('honors ctx.exitCode set by a command that otherwise succeeds', async () => {
    const { ctx, dataDir, home } = makeContext();
    await seedStore(dataDir, 'KJV', [{ book: 'PSA', chapter: '117', verses: { '1': 'O praise the LORD.' } }]);
    const path = join(home, 'sunday.yml');
    writeFileSync(path, 'translations: [KJV]\nverses:\n  - book: PSA\n    chapter: 117\n    verses: 1\n');
    ctx.exitCode = 5;
    await expect(runCli(ctx, ['get-verses', path])).resolves.toBe(5);
  });

  it('shows help and exits 1 when no command is given', async () => {
    const { ctx, stderr } = makeContext();
    await expect(runCli(ctx, [])).resolves.toBe(1);
    expect(stderr()).toContain('Usage: holydeck');
  });
});

describe('reportError', () => {
  it('prints HolyDeckError messages plainly in human mode', () => {
    const { ctx, stderr } = makeContext();
    const code = reportError(ctx, false, new HolyDeckError('no_last_sermon'));
    expect(code).toBe(1);
    expect(stderr()).toContain('No sermon file remembered yet.');
    expect(stderr()).not.toContain('{"error"');
  });

  it('prints the JSON envelope in --json mode', () => {
    const { ctx, stderr } = makeContext();
    const code = reportError(ctx, true, new HolyDeckError('unknown_shell', { shell: 'fish' }));
    expect(code).toBe(1);
    expect(JSON.parse(stderr())).toEqual({
      error: { code: 'unknown_shell', message: 'Unknown shell "fish". Supported: zsh, bash.' },
    });
  });

  it('passes commander exit codes through (help/version = 0)', () => {
    const { ctx } = makeContext();
    expect(reportError(ctx, false, new CommanderError(0, 'commander.helpDisplayed', '(outputHelp)'))).toBe(0);
    expect(reportError(ctx, false, new CommanderError(1, 'commander.unknownCommand', 'unknown command'))).toBe(1);
  });

  it('stringifies unknown errors', () => {
    const { ctx, stderr } = makeContext();
    expect(reportError(ctx, false, new Error('boom'))).toBe(1);
    expect(stderr()).toContain('boom');
    expect(reportError(ctx, false, 'plain failure')).toBe(1);
    expect(stderr()).toContain('plain failure');
  });
});
