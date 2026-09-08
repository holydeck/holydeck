import { spawn } from 'node:child_process';
import { HolyDeckError } from '@holydeck/core/messages';

export type SpawnEditor = (command: string, args: string[]) => Promise<number>;

export const spawnEditor: SpawnEditor = (command, args) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

export function createEditor(
  env: Record<string, string | undefined>,
  runner: SpawnEditor = spawnEditor,
): (path: string) => Promise<'opened' | 'skipped'> {
  return async (path) => {
    const editor = env['EDITOR']?.trim();
    if (!editor) return 'skipped';
    const [command, ...args] = editor.split(/\s+/) as [string, ...string[]];
    let status: number | 'spawn failed';
    try {
      status = await runner(command, [...args, path]);
    } catch {
      status = 'spawn failed';
    }
    if (status !== 0) throw new HolyDeckError('editor_failed', { editor: command, status });
    return 'opened';
  };
}
