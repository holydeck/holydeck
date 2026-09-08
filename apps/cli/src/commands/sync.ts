import { Command } from 'commander';
import { HolyDeckError } from '@holydeck/core/messages';
import { errLine, outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import { createRuntime, requireLocal } from '../runtime.js';
import { syncTranslation } from '@holydeck/core/sync';

export async function runSync(
  ctx: CliContext,
  abbrs: string[],
  options: { refresh?: boolean; dryRun?: boolean },
  globals: GlobalOptions,
): Promise<void> {
  const runtime = await createRuntime(ctx, { dataDir: globals.dataDir, serverUrl: globals.serverUrl });
  requireLocal(runtime, 'sync');
  const targets = abbrs.length > 0 ? abbrs : runtime.config.values.defaultTranslations;
  if (targets.length === 0) {
    throw new HolyDeckError('config_invalid_value', {
      key: 'defaultTranslations',
      value: '(empty)',
      reason: 'pass translation abbreviations or configure default translations',
    });
  }
  let anyFailed = false;
  for (const abbr of targets) {
    const upper = abbr.toUpperCase();
    const report = await syncTranslation(runtime.store, runtime.fetcher, upper, {
      refresh: options.refresh,
      dryRun: options.dryRun,
      concurrency: runtime.config.values.syncConcurrency,
      delayMs: runtime.config.values.syncDelayMs,
      onProgress: (done, total, item) => {
        errLine(ctx, `[${upper}] ${done}/${total} ${item.book} ${item.chapter}`);
      },
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
  }
  if (anyFailed) ctx.exitCode = 1;
}

export function registerSync(program: Command, ctx: CliContext): void {
  program
    .command('sync')
    .description('Download or update whole translations in the local datastore')
    .argument('[abbr...]', 'translation abbreviations (default: configured translations)')
    .option('--refresh', 're-fetch stored chapters and record changed content as new revisions')
    .option('--dry-run', 'show what would be fetched without fetching')
    .action(async (abbrs: string[], options: { refresh?: boolean; dryRun?: boolean }, command: Command) => {
      await runSync(ctx, abbrs, options, command.optsWithGlobals<GlobalOptions>());
    });
}
