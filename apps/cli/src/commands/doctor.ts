import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { configFilePath } from '@holydeck/core/config';
import { BROWSER_HEADERS } from '@holydeck/core/fetcher';
import { isChallengePage, versionUrl } from '@holydeck/core/scraper';
import { contentHash, validateStoreFile } from '@holydeck/core/storage';
import { outLine } from '../context.js';
import type { CliContext } from '../context.js';
import type { GlobalOptions } from '../program.js';
import type { Runtime } from '../runtime.js';
import { createRuntime } from '../runtime.js';
import { storedAbbrs } from './stats.js';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  detail: string;
}

async function checkDataDir(dataDir: string): Promise<DoctorCheck> {
  try {
    await mkdir(dataDir, { recursive: true });
    const probe = join(dataDir, '.holydeck-doctor-probe');
    await writeFile(probe, 'probe', 'utf8');
    await unlink(probe);
    return { name: 'data dir', status: 'ok', detail: 'writable' };
  } catch (error) {
    return { name: 'data dir', status: 'fail', detail: String(error) };
  }
}

async function checkDatastore(runtime: Runtime, dataDir: string): Promise<DoctorCheck> {
  if (runtime.mode === 'server') return { name: 'datastore', status: 'skipped', detail: 'server mode' };
  const abbrs = await storedAbbrs(dataDir);
  if (abbrs.length === 0) return { name: 'datastore', status: 'ok', detail: 'empty (nothing stored yet)' };
  const mismatches: string[] = [];
  try {
    for (const abbr of abbrs) {
      const file = await runtime.store.load(abbr);
      /* v8 ignore next */
      if (file === undefined) continue;
      validateStoreFile(file, join(dataDir, 'bibles', `${abbr}.json`));
      for (const [usfm, book] of Object.entries(file.books)) {
        for (const [chapter, record] of Object.entries(book.chapters)) {
          const last = record.revisions.at(-1);
          if (last !== undefined && contentHash(last.verses) !== last.contentHash) {
            mismatches.push(`${abbr} ${usfm} ${chapter} rev ${last.rev}`);
          }
        }
      }
    }
  } catch (error) {
    return { name: 'datastore', status: 'fail', detail: String(error) };
  }
  if (mismatches.length > 0) {
    return { name: 'datastore', status: 'warn', detail: `content hash mismatch: ${mismatches.join(', ')}` };
  }
  return { name: 'datastore', status: 'ok', detail: `${abbrs.length} translations valid` };
}

async function checkBibleCom(ctx: CliContext): Promise<DoctorCheck> {
  try {
    const response = await ctx.httpGet(versionUrl(1), BROWSER_HEADERS);
    if (response.status >= 400) {
      return { name: 'bible.com', status: 'fail', detail: `HTTP ${response.status}` };
    }
    if (isChallengePage(response.body)) {
      return { name: 'bible.com', status: 'warn', detail: 'reachable but blocked by a challenge page' };
    }
    return { name: 'bible.com', status: 'ok', detail: 'reachable' };
  } catch (error) {
    return { name: 'bible.com', status: 'fail', detail: String(error) };
  }
}

async function checkServer(runtime: Runtime | undefined): Promise<DoctorCheck> {
  if (runtime?.server === undefined) return { name: 'server', status: 'skipped', detail: 'no server configured' };
  try {
    const health = await runtime.server.health();
    return { name: 'server', status: 'ok', detail: `${health.store} store, up ${health.uptime}s` };
  } catch (error) {
    return { name: 'server', status: 'fail', detail: String(error) };
  }
}

export async function runDoctor(ctx: CliContext, globals: GlobalOptions): Promise<void> {
  const checks: DoctorCheck[] = [];
  let runtime: Runtime | undefined;
  const configPath = configFilePath(ctx.platform);
  try {
    runtime = await createRuntime(ctx, { dataDir: globals.dataDir, serverUrl: globals.serverUrl });
    checks.push({
      name: 'config',
      status: 'ok',
      detail: existsSync(configPath) ? `parsed ${configPath}` : 'not present (defaults apply)',
    });
  } catch (error) {
    checks.push({ name: 'config', status: 'fail', detail: String(error) });
  }
  const dataDir = runtime?.config.values.dataDir ?? ctx.platform.env['HOLYDECK_DATA_DIR'];
  if (dataDir === undefined) {
    checks.push({ name: 'data dir', status: 'skipped', detail: 'unknown (config failed)' });
    checks.push({ name: 'datastore', status: 'skipped', detail: 'unknown (config failed)' });
  } else {
    checks.push(await checkDataDir(dataDir));
    checks.push(
      runtime === undefined
        ? { name: 'datastore', status: 'skipped', detail: 'unknown (config failed)' }
        : await checkDatastore(runtime, dataDir),
    );
  }
  checks.push(await checkBibleCom(ctx));
  checks.push(await checkServer(runtime));
  if (globals.json === true) {
    outLine(ctx, JSON.stringify({ checks }, undefined, 2));
  } else {
    for (const check of checks) {
      outLine(ctx, `${check.status.padEnd(7)} ${check.name} — ${check.detail}`);
    }
  }
  if (checks.some((check) => check.status === 'fail')) ctx.exitCode = 1;
}

export function registerDoctor(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('Check config, datastore, network, and server health')
    .action(async (_options: Record<string, never>, command: Command) => {
      await runDoctor(ctx, command.optsWithGlobals<GlobalOptions>());
    });
}
