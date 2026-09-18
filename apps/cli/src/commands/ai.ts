import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { HolyDeckError, formatMessage } from '@holydeck/core/messages';
import { generateSermonFromText } from '@holydeck/core/sermon-ai';
import type { GenerateSermonOptions, IntegrationCallInfo } from '@holydeck/core/sermon-ai';
import { errLine, outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import { createRuntime, runtimeFlags } from '../runtime.js';
import { writeState } from '../state.js';

/** What a file gets when nothing is configured, spelled the same way `new` spells it in its scaffold. */
const FALLBACK_TRANSLATIONS = ['KJV'];

export interface AiOptions {
  stdin?: boolean;
  clipboard?: boolean;
  yes?: boolean;
}

/**
 * Where the pasted message comes from. A pipe wins when there is one, because a run with something
 * piped in meant to send that; an empty or blank pipe is not an answer, so it falls through to the
 * clipboard rather than refusing. A flag settles it either way and never consults the other source —
 * `--stdin` on an empty pipe fails on the empty message instead of quietly pasting something else.
 */
export async function readMessage(ctx: CliContext, options: AiOptions): Promise<string> {
  if (options.clipboard === true) return ctx.readClipboard();
  const piped = await ctx.readStdin();
  if (options.stdin === true) return piped ?? '';
  return piped === undefined || piped.trim() === '' ? ctx.readClipboard() : piped;
}

/**
 * One line per outbound call, and the only place the CLI says anything about one at all. It repeats
 * what the entry carries and nothing else: the entry itself never holds the prompt, the book names or
 * the key, so there is nothing here to leak.
 */
function reportCall(ctx: CliContext, call: IntegrationCallInfo): void {
  const counts =
    call.requestTokens === undefined || call.responseTokens === undefined
      ? ''
      : ` (${call.requestTokens} in, ${call.responseTokens} out)`;
  errLine(
    ctx,
    formatMessage('integration_called', {
      subject: call.subject,
      outcome: call.outcome,
      durationMs: call.durationMs,
      tokens: counts,
    }),
  );
}

export async function runAi(ctx: CliContext, options: AiOptions, globals: GlobalOptions): Promise<void> {
  const runtime = await createRuntime(ctx, runtimeFlags(globals));
  const rawText = await readMessage(ctx, options);

  const configured = runtime.config.values.defaultTranslations;
  const generateOptions: GenerateSermonOptions = {
    translations: configured.length > 0 ? configured : FALLBACK_TRANSLATIONS,
    now: ctx.now(),
    httpPost: ctx.httpPost,
    onIntegrationCall: (call) => {
      reportCall(ctx, call);
    },
  };
  const apiKey = runtime.config.values.anthropicApiKey;
  if (apiKey !== undefined) generateOptions.apiKey = apiKey;
  const sermon = await generateSermonFromText(rawText, generateOptions);

  const path = join(ctx.cwd, sermon.filename);
  // Checked before the preview and the question: refusing after someone has agreed to write would
  // make the confirmation a lie, and there is nothing to decide once the answer can only be no.
  if (existsSync(path)) throw new HolyDeckError('file_exists', { path });

  errLine(ctx, `${path}:`);
  // The built YAML always ends with its own newline, so the preview needs none added.
  ctx.err(sermon.yaml);
  for (const notice of sermon.notices) errLine(ctx, notice);

  if (options.yes !== true) {
    if (!ctx.isTTY) throw new HolyDeckError('confirmation_required', { path });
    if (!(await ctx.confirm(`Write ${path}?`))) {
      errLine(ctx, formatMessage('write_declined'));
      return;
    }
  }
  await writeFile(path, sermon.yaml, { encoding: 'utf8', flag: 'wx' });
  await writeState(runtime.config.values.dataDir, { lastSermonFile: path });
  outLine(ctx, path);
}

export function registerAi(program: Command, ctx: CliContext): void {
  program
    .command('ai')
    .description('Turn a pasted sermon message into a sermon file')
    .option('--clipboard', 'read the message from the system clipboard')
    .option('--stdin', 'read the message from standard input')
    .option('--yes', 'write the file without asking')
    .action(async (options: AiOptions, command: Command) => {
      await runAi(ctx, options, command.optsWithGlobals<GlobalOptions>());
    });
}
