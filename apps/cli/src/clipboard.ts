import { spawn } from 'node:child_process';
import { HolyDeckError } from '@holydeck/core/messages';

export type SpawnClipboard = (command: string, args: string[], text: string) => Promise<number>;

export type SpawnCapture = (command: string, args: string[]) => Promise<{ code: number; text: string }>;

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

/**
 * The read side of the same list. It is a separate list because the tools are not the same: Windows
 * writes with `clip.exe`, which has no read side at all, so reading goes through PowerShell instead.
 */
export function clipboardReadCommands(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): Array<{ command: string; args: string[] }> {
  if (platform === 'darwin') return [{ command: 'pbpaste', args: [] }];
  if (platform === 'win32') return [{ command: 'powershell', args: ['-NoProfile', '-Command', 'Get-Clipboard'] }];
  const commands = [{ command: 'xclip', args: ['-selection', 'clipboard', '-o'] }];
  if (env['WAYLAND_DISPLAY']) commands.unshift({ command: 'wl-paste', args: [] });
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

export const spawnCapture: SpawnCapture = (command, args) =>
  new Promise<{ code: number; text: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      text += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, text }));
  });

export function createClipboardReader(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  runner: SpawnCapture = spawnCapture,
): () => Promise<string> {
  return async () => {
    const candidates = clipboardReadCommands(platform, env);
    for (const candidate of candidates) {
      try {
        const result = await runner(candidate.command, candidate.args);
        if (result.code === 0) return result.text;
      } catch {
        // binary missing — try the next one
      }
    }
    throw new HolyDeckError('clipboard_read_unavailable', {
      tried: candidates.map((candidate) => candidate.command).join(', '),
    });
  };
}
