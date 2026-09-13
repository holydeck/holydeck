import { MESSAGE_CODES, REMOVED_CODES, messageCodeProblems } from '@holydeck/contracts/http';

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

/**
 * Grades the released message code registry before the service starts serving from it. A registry that
 * has repurposed or withdrawn a code is a promise already broken, and it is better to refuse to start
 * than to hand clients a code that no longer means what they were told it means.
 */
export function checkReleasedContracts(
  codes: unknown = MESSAGE_CODES,
  removedCodes: unknown = REMOVED_CODES,
): void {
  const problems = messageCodeProblems(codes, removedCodes);
  if (problems.length > 0) {
    throw new Error(`the released message codes cannot be served: ${problems.join('; ')}`);
  }
}
