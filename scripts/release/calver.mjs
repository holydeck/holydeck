// Lockstep release versioning: calver `yyyy.m.patch` (UTC year, unpadded UTC
// month, patch = release counter within the month starting at 0), with an
// optional `-next.N` prerelease suffix for the next channel. Every value is
// valid semver, so npm, pnpm, and release-it accept it unchanged.

export const CALVER_PATTERN = /^(\d{4})\.(\d{1,2})\.(\d+)(?:-next\.(\d+))?$/;

export function nextCalver(latestVersion, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const match = CALVER_PATTERN.exec(String(latestVersion ?? '').replace(/^v/, ''));
  if (match && Number(match[1]) === year && Number(match[2]) === month) {
    return `${year}.${month}.${Number(match[3]) + 1}`;
  }
  return `${year}.${month}.0`;
}

export function nextPrerelease(latestStable, latestPrerelease, now = new Date()) {
  const nextStableBase = nextCalver(latestStable, now);
  const match = CALVER_PATTERN.exec(String(latestPrerelease ?? '').replace(/^v/, ''));
  if (match) {
    const base = `${match[1]}.${match[2]}.${match[3]}`;
    const n = match[4];
    if (base === nextStableBase && n !== undefined) {
      return `${nextStableBase}-next.${Number(n) + 1}`;
    }
  }
  return `${nextStableBase}-next.1`;
}
