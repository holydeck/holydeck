import { homedir } from 'node:os';
import type { BrowserLauncher } from '@holydeck/core/browser-fetch';
import type { PlatformInfo } from '@holydeck/core/config';
import type { HttpGet } from '@holydeck/core/fetcher';
import { createPuppeteerLauncher } from '@holydeck/core/puppeteer-launcher';
import { createClipboard } from './clipboard.js';
import { createEditor } from './editor.js';
import type { HttpPost } from './server-client.js';

export interface CliContext {
  platform: PlatformInfo;
  cwd: string;
  isTTY: boolean;
  /** Set by commands that report failures without aborting (preflight, doctor). */
  exitCode?: number;
  out: (text: string) => void;
  err: (text: string) => void;
  clipboard: (text: string) => Promise<void>;
  editor: (path: string) => Promise<'opened' | 'skipped'>;
  httpGet: HttpGet;
  httpPost: HttpPost;
  /** Starts the headless browser used when browserFetch is on; tests substitute a fake. */
  browserLauncher?: BrowserLauncher;
  now: () => Date;
  /** Injectable retry backoff sleep for the core Fetcher (tests skip real delays). */
  sleep?: (ms: number) => Promise<void>;
}

export function outLine(ctx: CliContext, line: string): void {
  ctx.out(`${line}\n`);
}

export function errLine(ctx: CliContext, line: string): void {
  ctx.err(`${line}\n`);
}

export function computeIsTTY(stdoutTTY: boolean | undefined, stdinTTY: boolean | undefined): boolean {
  return stdoutTTY === true && stdinTTY === true;
}

export const fetchHttpGet: HttpGet = async (url, headers) => {
  const response = await fetch(url, { headers, redirect: 'follow' });
  return { status: response.status, body: await response.text() };
};

export const fetchHttpPost: HttpPost = async (url, body, headers) => {
  const response = await fetch(url, { method: 'POST', body, headers });
  return { status: response.status, body: await response.text() };
};

export function defaultContext(): CliContext {
  return {
    platform: { platform: process.platform, env: process.env, homeDir: homedir() },
    cwd: process.cwd(),
    isTTY: computeIsTTY(process.stdout.isTTY, process.stdin.isTTY),
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    clipboard: createClipboard(process.platform, process.env),
    editor: createEditor(process.env),
    httpGet: fetchHttpGet,
    httpPost: fetchHttpPost,
    browserLauncher: createPuppeteerLauncher(),
    now: () => new Date(),
  };
}
