import { Command } from 'commander';
import { HolyDeckError } from '@holydeck/core/messages';
import { errLine, outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import { createRuntime, runtimeFlags } from '../runtime.js';
import type { Runtime } from '../runtime.js';
import { startSpinner } from '../spinner.js';
import { syncTranslation } from '@holydeck/core/sync';
import type { ServerSyncJobStatus } from '../server-client.js';

export async function runSync(
  ctx: CliContext,
  abbrs: string[],
  options: { refresh?: boolean; dryRun?: boolean },
  globals: GlobalOptions,
): Promise<void> {
  const runtime = await createRuntime(ctx, runtimeFlags(globals));
  const targets = abbrs.length > 0 ? abbrs : runtime.config.values.defaultTranslations;
  if (targets.length === 0) {
    throw new HolyDeckError('config_invalid_value', {
      key: 'defaultTranslations',
      value: '(empty)',
      reason: 'pass translation abbreviations or configure default translations',
    });
  }
  if (runtime.mode === 'local') {
    await runSyncLocal(ctx, runtime, targets, options);
    return;
  }
  // T7 adds the server branch
  throw new HolyDeckError('local_only_command', { command: 'sync' });
}

async function runSyncLocal(
  ctx: CliContext,
  runtime: Runtime,
  targets: string[],
  options: { refresh?: boolean; dryRun?: boolean },
): Promise<void> {
  let anyFailed = false;
  for (const abbr of targets) {
    const upper = abbr.toUpperCase();
    // Opening the browser, fetching the canon and planning the run are silent and can take a
    // while; without this the command looks hung until the first chapter arrives.
    const spinner = startSpinner(ctx, `${upper}: preparing`);
    const report = await syncTranslation(runtime.store, runtime.fetcher, upper, {
      refresh: options.refresh,
      dryRun: options.dryRun,
      concurrency: runtime.config.values.syncConcurrency,
      delayMs: runtime.config.values.syncDelayMs,
      signal: ctx.abortSignal,
      onProgress: (done, total, item) => {
        spinner.stop();
        errLine(ctx, `[${upper}] ${done}/${total} ${item.book} ${item.chapter}`);
      },
    }).finally(() => {
      spinner.stop();
    });
    if (options.dryRun === true) {
      // dry-run reports every planned chapter and stops before fetching;
      // Phase 1 guarantees plan is set whenever dryRun is true, so the fallback is defensive
      /* v8 ignore next */
      const plan = report.plan ?? [];
      for (const item of plan) outLine(ctx, `${item.book} ${item.chapter} (${item.reason})`);
      outLine(ctx, `dry run: ${report.planned} chapters would be fetched.`);
      continue;
    }
    if (report.metadataBuildChanged !== undefined) {
      outLine(
        ctx,
        `${upper} metadata build changed ${report.metadataBuildChanged.from} → ${report.metadataBuildChanged.to}.`,
      );
    }
    outLine(
      ctx,
      `${upper}: ${report.planned} planned, ${report.fetched} fetched, ${report.unchanged} unchanged, ` +
        `${report.newRevisions.length} new revisions, ${report.failed.length} failed`,
    );
    if (options.refresh === true && report.newRevisions.length > 0) {
      const refs = report.newRevisions.map((item) => `${item.book} ${item.chapter}`).join(', ');
      outLine(ctx, `${report.newRevisions.length} chapters changed online: ${refs} (new revisions created)`);
    }
    for (const failure of report.failed) {
      outLine(ctx, `failed: ${failure.book} ${failure.chapter} (${failure.code})`);
      anyFailed = true;
    }
    if (report.aborted === true) {
      outLine(ctx, `${upper}: stopped early — run sync again to continue where it left off.`);
      ctx.exitCode = 130;
      return;
    }
  }
  if (anyFailed) ctx.exitCode = 1;
}

export async function runSyncStatus(ctx: CliContext, abbrs: string[], globals: GlobalOptions): Promise<void> {
  const runtime = await createRuntime(ctx, runtimeFlags(globals));
  const targets = abbrs.length > 0 ? abbrs : runtime.config.values.defaultTranslations;
  if (targets.length === 0) {
    throw new HolyDeckError('config_invalid_value', {
      key: 'defaultTranslations',
      value: '(empty)',
      reason: 'pass translation abbreviations or configure default translations',
    });
  }
  if (runtime.mode === 'local') {
    if (globals.json === true) {
      outLine(ctx, JSON.stringify(targets.map((abbr) => ({ abbr: abbr.toUpperCase(), job: null })), undefined, 2));
      return;
    }
    for (const abbr of targets) outLine(ctx, `${abbr.toUpperCase()}: no background jobs locally.`);
    return;
  }
  const server = runtime.server;
  /* v8 ignore next */
  if (server === undefined) throw new HolyDeckError('internal_error');
  const results: Array<{ abbr: string; job: ServerSyncJobStatus | null }> = [];
  for (const abbr of targets) {
    const upper = abbr.toUpperCase();
    results.push({ abbr: upper, job: (await server.syncStatus(upper)) ?? null });
  }
  if (globals.json === true) {
    outLine(ctx, JSON.stringify(results, undefined, 2));
    return;
  }
  for (const { abbr, job } of results) {
    if (job === null) {
      outLine(ctx, `${abbr}: no sync job yet.`);
      continue;
    }
    const times =
      job.finishedAt === undefined ? `started ${job.startedAt}` : `started ${job.startedAt}, finished ${job.finishedAt}`;
    outLine(ctx, `${abbr}: ${job.state}, ${job.progress.done}/${job.progress.total} chapters, ${times}`);
    if (job.state === 'failed' && job.error !== undefined) {
      outLine(ctx, `  error: ${job.error.message}`);
    }
  }
}

export function registerSync(program: Command, ctx: CliContext): void {
  const sync = program
    .command('sync')
    .description('Download or update whole translations in the local datastore')
    .argument('[abbr...]', 'translation abbreviations (default: configured translations)')
    .option('--refresh', 're-fetch stored chapters and record changed content as new revisions')
    .option('--dry-run', 'show what would be fetched without fetching')
    .action(async (abbrs: string[], options: { refresh?: boolean; dryRun?: boolean }, command: Command) => {
      await runSync(ctx, abbrs, options, command.optsWithGlobals<GlobalOptions>());
    });
  // No known translation abbreviation is literally "STATUS" today, so this doesn't collide with
  // the [abbr...] action above; commander matches a positional "status" against this subcommand
  // name before falling back to sync's own action.
  sync
    .command('status')
    .description('Show background sync job status per translation')
    .argument('[abbr...]', 'translation abbreviations (default: configured translations)')
    .action(async (abbrs: string[], _options: Record<string, never>, command: Command) => {
      await runSyncStatus(ctx, abbrs, command.optsWithGlobals<GlobalOptions>());
    });
}
