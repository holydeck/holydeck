import { Command, Option } from 'commander';
import { HolyDeckError } from '@holydeck/core/messages';
import { knownTranslations } from '@holydeck/core/translations';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';

export const COMMAND_NAMES = [
  'get-verses',
  'get',
  'new',
  'preflight',
  'sync',
  'stats',
  'translations',
  'info',
  'config',
  'revisions',
  'offsets',
  'import',
  'doctor',
  'completion',
];

function zshScript(): string {
  return [
    '#compdef holydeck',
    '_holydeck() {',
    '  local -a commands translations',
    `  commands=(${COMMAND_NAMES.join(' ')})`,
    '  if (( CURRENT == 2 )); then',
    '    _describe "command" commands',
    '  else',
    '    case "$words[2]" in',
    '      sync|revisions|offsets)',
    '        translations=($(holydeck completion --translations 2>/dev/null))',
    '        _describe "translation" translations',
    '        ;;',
    '      *)',
    '        _files',
    '        ;;',
    '    esac',
    '  fi',
    '}',
    '_holydeck "$@"',
    '',
  ].join('\n');
}

function bashScript(): string {
  return [
    '_holydeck() {',
    '  local cur=${COMP_WORDS[COMP_CWORD]}',
    '  if [ "$COMP_CWORD" -eq 1 ]; then',
    `    COMPREPLY=($(compgen -W "${COMMAND_NAMES.join(' ')}" -- "$cur"))`,
    '    return',
    '  fi',
    '  case "${COMP_WORDS[1]}" in',
    '    sync|revisions|offsets)',
    '      COMPREPLY=($(compgen -W "$(holydeck completion --translations 2>/dev/null)" -- "$cur"))',
    '      ;;',
    '    *)',
    '      COMPREPLY=($(compgen -f -- "$cur"))',
    '      ;;',
    '  esac',
    '}',
    'complete -F _holydeck holydeck',
    '',
  ].join('\n');
}

export function runCompletion(
  ctx: CliContext,
  shell: string | undefined,
  options: { translations?: boolean },
): void {
  if (options.translations === true) {
    for (const abbr of Object.keys(knownTranslations).sort()) outLine(ctx, abbr);
    return;
  }
  if (shell === 'zsh') {
    ctx.out(zshScript());
    return;
  }
  if (shell === 'bash') {
    ctx.out(bashScript());
    return;
  }
  throw new HolyDeckError('unknown_shell', { shell: shell ?? '(none)' });
}

export function registerCompletion(program: Command, ctx: CliContext): void {
  program
    .command('completion')
    .description('Print a shell completion script (zsh or bash)')
    .argument('[shell]', 'zsh or bash')
    .addOption(new Option('--translations', 'print known translation abbreviations').hideHelp())
    .action((shell: string | undefined, options: { translations?: boolean }) => {
      runCompletion(ctx, shell, options);
    });
}
