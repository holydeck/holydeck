import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CliState {
  lastSermonFile?: string;
}

export function statePath(dataDir: string): string {
  return join(dataDir, 'state.json');
}

export async function readState(dataDir: string): Promise<CliState> {
  let raw: string;
  try {
    raw = await readFile(statePath(dataDir), 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const state: CliState = {};
  const last = (parsed as Record<string, unknown>)['lastSermonFile'];
  if (typeof last === 'string') state.lastSermonFile = last;
  return state;
}

export async function writeState(dataDir: string, state: CliState): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath(dataDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
