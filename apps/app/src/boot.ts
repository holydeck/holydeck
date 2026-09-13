/** Reads the settings file if it is there. A fresh install has none, and that is not a fault. */
export function readSettingsText(read: (path: string) => string, path: string): string | undefined {
  try {
    return read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A file that exists but cannot be read is a deployment fault: refusing to start beats
    // starting on defaults the administrator did not choose.
    throw error;
  }
}
