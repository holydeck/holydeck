import { describe, expect, it } from 'vitest';
import { knownTranslations } from '@holydeck/core/translations';
import { makeContext } from '../../test/harness.js';
import { runCli } from '../program.js';

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
    expect(setup.stderr()).toContain('Unknown shell');
  });

  it('prints known translation abbreviations with the hidden --translations flag', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--translations'])).resolves.toBe(0);
    const lines = setup.stdout().trimEnd().split('\n');
    expect(lines).toEqual(Object.keys(knownTranslations).sort());
  });

  it('hides --translations from help output', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--help'])).resolves.not.toBe(1);
    expect(setup.stdout()).not.toContain('--translations');
  });
});
