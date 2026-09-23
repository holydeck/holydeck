import { pathToFileURL } from 'node:url';
import { CALVER_PATTERN } from './calver.mjs';

export function channelOf(ref) {
  const tag = String(ref ?? '').replace(/^refs\/tags\//, '');
  const version = tag.replace(/^v/, '');
  if (!CALVER_PATTERN.test(version)) {
    throw new Error(`channel-of: "${ref}" is not a calver tag`);
  }
  const prerelease = version.includes('-next.');
  return {
    channel: prerelease ? 'next' : 'stable',
    distTag: prerelease ? 'next' : 'latest',
    prerelease,
    version,
  };
}

function main(ref) {
  try {
    const { channel, distTag, prerelease } = channelOf(ref);
    console.log(`channel=${channel}`);
    console.log(`dist_tag=${distTag}`);
    console.log(`prerelease=${prerelease}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.argv[2]);
