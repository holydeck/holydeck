import type { Settings } from '@holydeck/app/settings';

export interface WorkerPaths {
  dataDir: string;
  mediaRoot: string;
  jobsDir: string;
  spoolDir: string;
}

/** Carries every problem rather than the first, because a deployment fixes mounts in one pass. */
export class WorkerError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`the worker cannot run here:\n${problems.map((problem) => `  ${problem}`).join('\n')}`);
    this.name = 'WorkerError';
    this.problems = problems;
  }
}

export function workerPaths({ dataDir, mediaRoot }: Settings): WorkerPaths {
  return { dataDir, mediaRoot, jobsDir: `${dataDir}/jobs`, spoolDir: `${dataDir}/spool` };
}

export function assertUsablePaths(
  isWritable: (path: string) => boolean,
  paths: WorkerPaths,
): void {
  const problems = Object.values(paths)
    .filter((path) => !isWritable(path))
    .map((path) => `${path}: not writable`);
  // A worker that starts on a read-only mount fails later, per job, where nobody is watching.
  if (problems.length > 0) throw new WorkerError(problems);
}
