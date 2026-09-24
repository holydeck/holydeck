// The worker's own half of invariant 10: settings and media are files on disk, not Mongo documents
// `apps/app/src/backups.ts` can read inside a snapshot transaction, so they are backed up by shelling out
// to the one tool built for exactly that. Its NDJSON `summary` line is read back into the same
// `BackupContent` shape the Mongo archive reports in, so `finalizeBackup` can fold both halves into one
// manifest without caring which one produced which entry.

import { spawn } from 'node:child_process';

import type { BackupContent } from '@holydeck/contracts/backups';

export interface ResticOptions {
  readonly repository: string;
  /**
   * The password the repository is encrypted under. A backup is a second copy of everything a deployment
   * holds, on a disk that by design leaves the building, so there is no invocation here that will run
   * without one — see `run` below for why it is refused here rather than left to Restic.
   */
  readonly password: string;
}

// Two phrasings, not one: older restic refuses re-init with "already initialized", current restic
// (0.18) with "config file already exists" instead. Both mean the same thing here — a repository an
// earlier run already created — so both are success.
const ALREADY_INITIALIZED = /already initialized|config file already exists/iu;

interface ResticSummary {
  readonly message_type?: string;
  readonly files_new?: number;
  readonly files_changed?: number;
  readonly files_unmodified?: number;
  readonly total_bytes_processed?: number;
  readonly snapshot_id?: string;
}

const run = (options: ResticOptions, args: readonly string[], signal: AbortSignal): Promise<string> =>
  new Promise((resolve, reject) => {
    // Refused before anything is launched. Restic with no password and nothing on stdin fails on a
    // prompt nobody can answer, which reads as a problem with the terminal rather than what it is: a
    // deployment whose repository secret was never written. Said plainly instead, once, for every command.
    if (options.password === '') {
      reject(new Error('restic was given no repository password; this deployment has none set'));
      return;
    }
    // Through the environment, never the argument list: a command line is readable by every other process
    // on the host, and this one password opens every backup this deployment has ever taken.
    const child = spawn('restic', [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RESTIC_PASSWORD: options.password },
    });
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
    await run(options, ['init', '--repo', options.repository, '--json'], signal);
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
  const stdout = await run(options, ['backup', '--repo', options.repository, '--json', '--tag', tag, path], signal);
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

/** Puts one snapshot back under `target`, which is a directory of the rehearsal's choosing and never a live one. */
export async function restoreSnapshot(
  options: ResticOptions,
  snapshot: string,
  target: string,
  signal: AbortSignal,
): Promise<void> {
  await run(options, ['restore', snapshot, '--repo', options.repository, '--json', '--target', target], signal);
}

/**
 * A bounded sample of the pack data, rather than all of it: `--read-data` re-reads the whole repository,
 * and how long that takes grows with everything ever backed up, which is not a cost a rehearsal can take
 * on unbounded. Five percent is a probability of catching rot, not a proof of its absence.
 */
const READ_DATA_SAMPLE = '--read-data-subset=5%';

/**
 * What stands in for rehashing the snapshot-addressed content classes. Their manifest entries carry
 * `restic:<id>` — an address, not a digest — so there is nothing in the manifest to compare bytes against;
 * the repository's own check is what says that what those addresses point at is intact. A plain `check`
 * reads the repository's structure and never a byte of the pack data the snapshots are actually made of,
 * so a sample of that data is read back as well.
 */
export async function checkRepository(options: ResticOptions, signal: AbortSignal): Promise<void> {
  await run(options, ['check', '--repo', options.repository, READ_DATA_SAMPLE], signal);
}

/**
 * Forgets exactly the snapshots named and prunes what only they held. Retention decided which those are
 * (see `backup-retention`); this only carries it out, and does nothing at all when the answer was none.
 */
export async function forgetSnapshots(
  options: ResticOptions,
  snapshots: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  if (snapshots.length === 0) return 0;
  await run(options, ['forget', '--repo', options.repository, '--json', '--prune', ...snapshots], signal);
  return snapshots.length;
}
