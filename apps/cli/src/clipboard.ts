import { spawn } from 'node:child_process';
import { HolyDeckError } from '@holydeck/core/messages';

export type SpawnClipboard = (command: string, args: string[], text: string) => Promise<number>;

export function clipboardCommands(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): Array<{ command: string; args: string[] }> {
  if (platform === 'darwin') return [{ command: 'pbcopy', args: [] }];
  if (platform === 'win32') return [{ command: 'clip.exe', args: [] }];
  const commands = [{ command: 'xclip', args: ['-selection', 'clipboard'] }];
  if (env['WAYLAND_DISPLAY']) commands.unshift({ command: 'wl-copy', args: [] });
  return commands;
}

export const spawnClipboard: SpawnClipboard = (command, args, text) =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
    child.stdin.on('error', () => {
      // tool exited before reading stdin (e.g. `false`) — exit code decides the outcome
    });
    child.stdin.end(text);
  });

export function createClipboard(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  runner: SpawnClipboard = spawnClipboard,
): (text: string) => Promise<void> {
  return async (text) => {
    const candidates = clipboardCommands(platform, env);
    for (const candidate of candidates) {
      try {
        if ((await runner(candidate.command, candidate.args, text)) === 0) return;
      } catch {
        // binary missing — try the next one
      }
    }
    throw new HolyDeckError('clipboard_unavailable', {
      tried: candidates.map((candidate) => candidate.command).join(', '),
    });
  };
}
