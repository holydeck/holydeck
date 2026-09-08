import { describe, expect, it } from 'vitest';
import { makeContext } from '../../test/harness.js';
import { buildProgram, runCli } from '../program.js';
import { COMMAND_NAMES } from './completion.js';

// Hard-coded (not derived from the source) so dropping `.sort()` in completion.ts,
// or editing the translation catalog, surfaces here instead of silently passing.
const KNOWN_TRANSLATION_ABBREVIATIONS = ['AMP', 'ICL00D', 'KJV', 'NIV', 'NLT', 'NR06', 'SCH2000', 'TAOVBSI', 'VULG'];

describe('completion', () => {
  it('prints a zsh completion script', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', 'zsh'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('#compdef holydeck');
    expect(setup.stdout()).toContain('get-verses');
    expect(setup.stdout()).toContain('doctor');
  });

  it('prints a bash completion script', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', 'bash'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('complete -F _holydeck holydeck');
    expect(setup.stdout()).toContain('preflight');
  });

  it('rejects unknown shells', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', 'fish'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('Unknown shell "fish". Supported: zsh, bash.');
  });

  it('requires a shell argument unless --translations is used', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('Unknown shell "(none)". Supported: zsh, bash.');
  });

  it('prints known translation abbreviations with the hidden --translations flag', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--translations'])).resolves.toBe(0);
    const lines = setup.stdout().trimEnd().split('\n');
    expect(lines).toEqual(KNOWN_TRANSLATION_ABBREVIATIONS);
  });

  it('hides --translations from help output', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--help'])).resolves.not.toBe(1);
    expect(setup.stdout()).not.toContain('--translations');
  });

  it('keeps COMMAND_NAMES in sync with the commands registered on the program', () => {
    const setup = makeContext();
    const program = buildProgram(setup.ctx);
    const registered = program.commands.map((command) => command.name()).sort();
    expect(registered).toEqual([...COMMAND_NAMES].sort());
  });
});
