// The worker's own half of invariant 10: settings and media are files on disk, not Mongo documents
// `apps/app/src/backups.ts` can read inside a snapshot transaction, so they are backed up by shelling out
// to the one tool built for exactly that. Its NDJSON `summary` line is read back into the same
// `BackupContent` shape the Mongo archive reports in, so `finalizeBackup` can fold both halves into one
// manifest without caring which one produced which entry.

import { spawn } from 'node:child_process';

import type { BackupContent } from '@holydeck/contracts/backups';

export interface ResticOptions {
  readonly repository: string;
}

const ALREADY_INITIALIZED = /already initialized/iu;

interface ResticSummary {
  readonly message_type?: string;
  readonly files_new?: number;
  readonly files_changed?: number;
  readonly files_unmodified?: number;
  readonly total_bytes_processed?: number;
  readonly snapshot_id?: string;
}

const run = (args: readonly string[], signal: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('restic', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const abort = (): void => {
      child.kill();
    };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', reject);
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() !== '' ? stderr.trim() : `restic exited with code ${String(code)}`));
    });
  });

/**
 * Idempotent on purpose: a repository an earlier run already initialized is success, not failure, since
 * nothing about a backup run should depend on whether it happens to be the first one this deployment ever
 * takes.
 */
export async function initRepository(options: ResticOptions, signal: AbortSignal): Promise<void> {
  try {
    await run(['init', '--repo', options.repository, '--insecure-no-password', '--json'], signal);
  } catch (error) {
    if (ALREADY_INITIALIZED.test((error as Error).message)) return;
    throw error;
  }
}

function summaryOf(stdout: string): ResticSummary {
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if ((parsed as ResticSummary).message_type === 'summary') return parsed as ResticSummary;
  }
  throw new Error('restic backup produced no summary line');
}

/** Backs up one path under one tag, and reports it in the shape a backup manifest records content by. */
export async function backupPath(
  options: ResticOptions,
  className: string,
  tag: string,
  path: string,
  signal: AbortSignal,
): Promise<BackupContent> {
  const stdout = await run(
    ['backup', '--repo', options.repository, '--insecure-no-password', '--json', '--tag', tag, path],
    signal,
  );
  const summary = summaryOf(stdout);
  if (summary.snapshot_id === undefined || summary.snapshot_id === '') {
    throw new Error('restic backup summary named no snapshot');
  }
  return {
    class: className,
    count: (summary.files_new ?? 0) + (summary.files_changed ?? 0) + (summary.files_unmodified ?? 0),
    bytes: summary.total_bytes_processed ?? 0,
    hash: `restic:${summary.snapshot_id}`,
  };
}
