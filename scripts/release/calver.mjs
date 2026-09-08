// Lockstep release versioning: calver `yyyy.m.patch` (UTC year, unpadded UTC
// month, patch = release counter within the month starting at 0). Every value
// is valid semver, so npm, pnpm, and release-it accept it unchanged.

const CALVER_PATTERN = /^(\d{4})\.(\d{1,2})\.(\d+)$/;

export function nextCalver(latestVersion, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const match = CALVER_PATTERN.exec(String(latestVersion ?? '').replace(/^v/, ''));
  if (match && Number(match[1]) === year && Number(match[2]) === month) {
    return `${year}.${month}.${Number(match[3]) + 1}`;
  }
  return `${year}.${month}.0`;
}
