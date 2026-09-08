import { describe, expect, it } from 'vitest';
import { makeContext } from '../../test/harness.js';
import { buildProgram, runCli } from '../program.js';

// Hard-coded (not derived from the source) so dropping `.sort()` in completion.ts,
// or editing the translation catalog, surfaces here instead of silently passing.
const KNOWN_TRANSLATION_ABBREVIATIONS = ['AMP', 'ICL00D', 'KJV', 'NIV', 'NLT', 'NR06', 'SCH2000', 'TAOVBSI', 'VULG'];

describe('completion', () => {
  it('prints a zsh completion script that fetches commands live', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', 'zsh'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('#compdef holydeck');
    expect(setup.stdout()).toContain('holydeck completion --commands');
    // Must self-initialize compinit: dotfiles may source this before their own
    // compinit call runs, and compdef doesn't exist until compinit has.
    expect(setup.stdout()).toContain('autoload -Uz compinit && compinit');
  });

  it('prints a bash completion script that fetches commands live', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', 'bash'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('complete -F _holydeck holydeck');
    expect(setup.stdout()).toContain('holydeck completion --commands');
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

  it('hides --translations, --commands, --books, --flags and --arg-hint from help output', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--help'])).resolves.not.toBe(1);
    expect(setup.stdout()).not.toContain('--translations');
    expect(setup.stdout()).not.toContain('--commands');
    expect(setup.stdout()).not.toContain('--books');
    expect(setup.stdout()).not.toContain('--flags');
    expect(setup.stdout()).not.toContain('--arg-hint');
  });

  it('prints registered command names with descriptions with the hidden --commands flag', async () => {
    const registered = buildProgram(makeContext().ctx).commands.map(
      (command) => `${command.name()}:${command.description()}`,
    );

    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--commands'])).resolves.toBe(0);
    expect(setup.stdout().trimEnd().split('\n')).toEqual(registered);
  });

  it('prints USFM book codes with names with the hidden --books flag', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--books'])).resolves.toBe(0);
    const lines = setup.stdout().trimEnd().split('\n');
    expect(lines).toContain('GEN:Genesis');
    expect(lines).toContain('REV:Revelation');
    expect(lines).toHaveLength(66);
  });

  it('prints global flags with the hidden --flags option and no path', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--flags'])).resolves.toBe(0);
    const lines = setup.stdout().trimEnd().split('\n');
    expect(lines.some((line) => line.startsWith('--data-dir:'))).toBe(true);
  });

  it('prints a command own flags with the hidden --flags option and a command name', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--flags', 'revisions'])).resolves.toBe(0);
    expect(setup.stdout().trimEnd().split('\n')).toEqual([
      '--diff:diff two revisions, e.g. 1..3',
      '--help:display help for command',
      '-h:display help for command',
    ]);
  });

  it('resolves --flags through a nested subcommand path', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--flags', 'config', 'init'])).resolves.toBe(0);
    expect(setup.stdout().trimEnd().split('\n')).toEqual([
      '--force:overwrite an existing config file',
      '--help:display help for command',
      '-h:display help for command',
    ]);
  });

  it('falls back to the deepest resolvable command for --flags when a path segment is unknown', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--flags', 'revisions', 'bogus'])).resolves.toBe(0);
    expect(setup.stdout().trimEnd().split('\n')).toEqual([
      '--diff:diff two revisions, e.g. 1..3',
      '--help:display help for command',
      '-h:display help for command',
    ]);
  });

  it('falls back to global flags for --flags when the top-level segment is unknown', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--flags', 'bogus'])).resolves.toBe(0);
    const lines = setup.stdout().trimEnd().split('\n');
    expect(lines.some((line) => line.startsWith('--data-dir:'))).toBe(true);
  });

  it('includes -h/--help alongside the CLI own hidden flags', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--flags', 'completion'])).resolves.toBe(0);
    expect(setup.stdout().trimEnd().split('\n')).toEqual(['--help:display help for command', '-h:display help for command']);
  });

  it('lists nested subcommands with the hidden --commands option and a command name', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--commands', 'config'])).resolves.toBe(0);
    expect(setup.stdout().trimEnd().split('\n')).toEqual(['init:Write a commented starter config file']);
  });

  it('prints nothing for --commands on a leaf command with no subcommands', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--commands', 'revisions'])).resolves.toBe(0);
    expect(setup.stdout()).toBe('');
  });

  it('prints nothing for --commands when the top-level segment is unknown', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--commands', 'bogus'])).resolves.toBe(0);
    expect(setup.stdout()).toBe('');
  });

  it('prints nothing for --commands when a nested path segment is unknown', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--commands', 'bogus', 'sub'])).resolves.toBe(0);
    expect(setup.stdout()).toBe('');
  });

  it('prints nothing for --arg-hint with no path', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--arg-hint'])).resolves.toBe(0);
    expect(setup.stdout()).toBe('');
  });

  it('prints the next expected argument with the hidden --arg-hint option', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--arg-hint', 'get'])).resolves.toBe(0);
    expect(setup.stdout().trimEnd()).toBe('reference:reference like "PSA 118:24", "GEN 1:5-7,9" or "1. Mose 30:5"');
  });

  it('advances the argument hint as positional values are already typed', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--arg-hint', 'revisions', 'SCH2000', 'PSA'])).resolves.toBe(0);
    expect(setup.stdout().trimEnd()).toBe('chapter:chapter number');
  });

  it('prints nothing once every positional argument has already been typed', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--arg-hint', 'revisions', 'SCH2000', 'PSA', '3'])).resolves.toBe(0);
    expect(setup.stdout()).toBe('');
  });

  it('keeps hinting a variadic argument past its first value', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--arg-hint', 'sync', 'KJV', 'NIV'])).resolves.toBe(0);
    expect(setup.stdout().trimEnd()).toBe('abbr:translation abbreviations (default: configured translations)');
  });

  it('resolves --arg-hint through a nested subcommand path', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--arg-hint', 'config', 'init'])).resolves.toBe(0);
    expect(setup.stdout()).toBe('');
  });

  it('prints nothing for --arg-hint on a command with no positional arguments', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', '--arg-hint', 'doctor'])).resolves.toBe(0);
    expect(setup.stdout()).toBe('');
  });

  it('includes an arg-hint lookup and _message in the zsh script', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['completion', 'zsh'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('holydeck completion --arg-hint');
    expect(setup.stdout()).toContain('_message');
  });
});
