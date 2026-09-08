import { Command, Option } from 'commander';
import { bundledCanon } from '@holydeck/core/canon';
import { HolyDeckError } from '@holydeck/core/messages';
import { knownTranslations } from '@holydeck/core/translations';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';

function zshScript(): string {
  return [
    '#compdef holydeck',
    '(( $+functions[compdef] )) || { autoload -Uz compinit && compinit }',
    '_holydeck() {',
    '  local -a translations books',
    '  local raw',
    '  if [[ "$words[CURRENT]" == -* ]]; then',
    '    local -a flags',
    '    raw="$(holydeck completion --flags $words[2,CURRENT-1] 2>/dev/null)"',
    '    [[ -n "$raw" ]] && flags=("${(@f)raw}")',
    '    _describe "option" flags',
    '    return',
    '  fi',
    '  raw="$(holydeck completion --commands $words[2,CURRENT-1] 2>/dev/null)"',
    '  if [[ -n "$raw" ]]; then',
    '    local -a commands',
    '    commands=("${(@f)raw}")',
    '    _describe "command" commands',
    '    return',
    '  fi',
    '  _hint_or_files() {',
    '    local hint',
    '    hint="$(holydeck completion --arg-hint $words[2,CURRENT-1] 2>/dev/null)"',
    '    if [[ -n "$hint" ]]; then',
    '      _message -r "${hint/:/ — }"',
    '    else',
    '      _files',
    '    fi',
    '  }',
    '  case "$words[2]" in',
    '    sync)',
    '      translations=($(holydeck completion --translations 2>/dev/null))',
    '      _describe "translation" translations',
    '      ;;',
    '    revisions)',
    '      if (( CURRENT == 3 )); then',
    '        translations=($(holydeck completion --translations 2>/dev/null))',
    '        _describe "translation" translations',
    '      elif (( CURRENT == 4 )); then',
    '        books=("${(@f)$(holydeck completion --books 2>/dev/null)}")',
    '        _describe "book" books',
    '      else',
    '        _hint_or_files',
    '      fi',
    '      ;;',
    '    offsets)',
    '      if (( CURRENT == 3 || CURRENT == 4 )); then',
    '        translations=($(holydeck completion --translations 2>/dev/null))',
    '        _describe "translation" translations',
    '      elif (( CURRENT == 5 )); then',
    '        books=("${(@f)$(holydeck completion --books 2>/dev/null)}")',
    '        _describe "book" books',
    '      else',
    '        _hint_or_files',
    '      fi',
    '      ;;',
    '    *)',
    '      _hint_or_files',
    '      ;;',
    '  esac',
    '}',
    'compdef _holydeck holydeck',
    '',
  ].join('\n');
}

function bashScript(): string {
  return [
    '_holydeck() {',
    '  local cur=${COMP_WORDS[COMP_CWORD]}',
    '  if [[ "$cur" == -* ]]; then',
    '    COMPREPLY=($(compgen -W "$(holydeck completion --flags "${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null | cut -d: -f1)" -- "$cur"))',
    '    return',
    '  fi',
    '  local commands',
    '  commands="$(holydeck completion --commands "${COMP_WORDS[@]:1:COMP_CWORD-1}" 2>/dev/null)"',
    '  if [ -n "$commands" ]; then',
    '    COMPREPLY=($(compgen -W "$(printf \'%s\\n\' "$commands" | cut -d: -f1)" -- "$cur"))',
    '    return',
    '  fi',
    '  case "${COMP_WORDS[1]}" in',
    '    sync)',
    '      COMPREPLY=($(compgen -W "$(holydeck completion --translations 2>/dev/null)" -- "$cur"))',
    '      ;;',
    '    revisions)',
    '      if [ "$COMP_CWORD" -eq 2 ]; then',
    '        COMPREPLY=($(compgen -W "$(holydeck completion --translations 2>/dev/null)" -- "$cur"))',
    '      elif [ "$COMP_CWORD" -eq 3 ]; then',
    '        COMPREPLY=($(compgen -W "$(holydeck completion --books 2>/dev/null | cut -d: -f1)" -- "$cur"))',
    '      else',
    '        COMPREPLY=($(compgen -f -- "$cur"))',
    '      fi',
    '      ;;',
    '    offsets)',
    '      if [ "$COMP_CWORD" -eq 2 ] || [ "$COMP_CWORD" -eq 3 ]; then',
    '        COMPREPLY=($(compgen -W "$(holydeck completion --translations 2>/dev/null)" -- "$cur"))',
    '      elif [ "$COMP_CWORD" -eq 4 ]; then',
    '        COMPREPLY=($(compgen -W "$(holydeck completion --books 2>/dev/null | cut -d: -f1)" -- "$cur"))',
    '      else',
    '        COMPREPLY=($(compgen -f -- "$cur"))',
    '      fi',
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

export interface CompletionOptions {
  translations?: boolean;
  commands?: boolean | string[];
  books?: boolean;
  flags?: boolean | string[];
  argHint?: boolean | string[];
}

/** Walks a strict subcommand-name path; undefined as soon as a segment doesn't match. */
function findCommand(program: Command, path: string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const segment of path) current = current?.commands.find((c) => c.name() === segment);
  return current;
}

interface DeepestMatch {
  command: Command;
  /** How many leading path segments were consumed as subcommand names; the rest are argument values. */
  consumed: number;
}

/** Walks as far as consecutive subcommand names match, then stops — never undefined. */
function findDeepestCommand(program: Command, path: string[]): DeepestMatch {
  let command = program;
  let consumed = 0;
  for (const segment of path) {
    const next = command.commands.find((c) => c.name() === segment);
    if (next === undefined) break;
    command = next;
    consumed += 1;
  }
  return { command, consumed };
}

export function runCompletion(
  ctx: CliContext,
  program: Command,
  shell: string | undefined,
  options: CompletionOptions,
): void {
  if (options.translations === true) {
    for (const abbr of Object.keys(knownTranslations).sort()) outLine(ctx, abbr);
    return;
  }
  if (options.commands !== undefined) {
    const path = Array.isArray(options.commands) ? options.commands : [];
    const target = findCommand(program, path);
    for (const command of target?.commands ?? []) outLine(ctx, `${command.name()}:${command.description()}`);
    return;
  }
  if (options.books === true) {
    for (const book of bundledCanon().books) outLine(ctx, `${book.usfm}:${book.name}`);
    return;
  }
  if (options.flags !== undefined) {
    const path = Array.isArray(options.flags) ? options.flags : [];
    const { command } = findDeepestCommand(program, path);
    for (const option of command.createHelp().visibleOptions(command)) {
      outLine(ctx, `${option.long}:${option.description}`);
      if (option.short) outLine(ctx, `${option.short}:${option.description}`);
    }
    return;
  }
  if (options.argHint !== undefined) {
    const path = Array.isArray(options.argHint) ? options.argHint : [];
    const { command, consumed } = findDeepestCommand(program, path);
    const args = command.registeredArguments;
    const lastArg = args[args.length - 1];
    const arg = args[path.length - consumed] ?? (lastArg?.variadic === true ? lastArg : undefined);
    if (arg !== undefined) outLine(ctx, `${arg.name()}:${arg.description}`);
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
    .addOption(new Option('--commands [path...]', 'print subcommand names for a command path (or top-level if omitted)').hideHelp())
    .addOption(new Option('--books', 'print USFM book codes').hideHelp())
    .addOption(new Option('--flags [path...]', 'print option flags for a command path (or global flags if omitted)').hideHelp())
    .addOption(new Option('--arg-hint [path...]', 'print the name and description of the next expected positional argument for a command path').hideHelp())
    .action((shell: string | undefined, options: CompletionOptions) => {
      runCompletion(ctx, program, shell, options);
    });
}
