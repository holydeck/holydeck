// Starting, waiting for, and stopping the real processes the stack is made of.
//
// The harness runs the built entry points rather than importing what is inside them, so that what it
// grades is what a deployment runs. That means every failure arrives as an exit code and some output on
// a pipe, and a harness that loses either reports "the application was not ready" for a settings error
// that said exactly what was wrong. Nothing here swallows output.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';

export type Environment = Readonly<Record<string, string>>;

export interface RunResult {
  readonly code: number | null;
  readonly output: string;
}

export interface Exit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface Served {
  /** Everything the service has written so far, both streams, in the order it arrived. */
  output(): string;
  /** How the service ended, or nothing while it is still running. */
  exit(): Exit | undefined;
  stopped(): Promise<void>;
  stop(): Promise<void>;
}

/** How long a service is given to honour a signal to stop before it is killed. */
export const GRACE_MS = 5_000;

/** How long a service is given to become ready, and how often it is asked. */
export const READY_TIMEOUT_MS = 120_000;
export const READY_EVERY_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const collect = (child: ChildProcess, onText: (text: string) => void): void => {
  for (const stream of [child.stdout, child.stderr]) stream?.setEncoding('utf8').on('data', onText);
};

/** A port nothing is listening on, asked of the operating system rather than guessed at. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The port a caller asked for, or a free one when it does not care which. */
export async function portFor(given: number | undefined): Promise<number> {
  return given ?? freePort();
}

export function run(args: readonly string[], env: Environment): Promise<RunResult> {
  const child = spawn(process.execPath, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  collect(child, (text) => {
    output += text;
  });
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** The same, for a step whose failure means the stack cannot be started at all. */
export async function runOrThrow(args: readonly string[], env: Environment, label: string): Promise<void> {
  const result = await run(args, env);
  if (result.code !== 0) throw new Error(`${label} exited with ${result.code}:\n${result.output}`);
}

/** Whether an address answers at all. What it answers is the assertion's business, not the wait's. */
export async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

export function serve(
  args: readonly string[],
  env: Environment,
  { graceMs = GRACE_MS }: { graceMs?: number } = {},
): Served {
  const child = spawn(process.execPath, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let ended: Exit | undefined;
  collect(child, (text) => {
    output += text;
  });
  const stopped = new Promise<void>((resolve) => {
    child.on('close', (code, signal) => {
      ended = { code, signal };
      resolve();
    });
  });

  return {
    output: () => output,
    exit: () => ended,
    stopped: () => stopped,
    async stop() {
      if (ended !== undefined) return;
      child.kill('SIGTERM');
      // A service that does not honour the signal still has to stop, or the run that started it hangs
      // for as long as the process lives — which, for a worker on a timer, is forever.
      await Promise.race([stopped, sleep(graceMs).then(() => void child.kill('SIGKILL'))]);
      await stopped;
    },
  };
}

/**
 * Waits for a service to be ready, and refuses rather than waits when it cannot become ready. A service
 * that exited is never going to answer, so waiting out the timeout would only delay the reason, which is
 * already sitting in its output.
 */
export async function ready(
  served: Served,
  label: string,
  check: () => Promise<boolean>,
  { timeoutMs = READY_TIMEOUT_MS, everyMs = READY_EVERY_MS }: { timeoutMs?: number; everyMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ended = served.exit();
    if (ended !== undefined) {
      throw new Error(`${label} exited with ${ended.code ?? ended.signal} before it was ready:\n${served.output()}`);
    }
    if (await check()) return;
    if (Date.now() >= deadline) {
      throw new Error(`${label} was not ready within ${timeoutMs}ms:\n${served.output()}`);
    }
    await sleep(everyMs);
  }
}
