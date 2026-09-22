import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { selfSignedCertificate, tlsEnvironment } from './tls.js';

const OPENSSL_AVAILABLE = spawnSync('openssl', ['version']).status === 0;

const directories: string[] = [];
const scratch = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'holydeck-harness-tls-'));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('the certificate a browser run reaches its stack with', () => {
  it.skipIf(!OPENSSL_AVAILABLE)('writes a PEM certificate and key into the directory it is given', () => {
    const directory = scratch();
    const certificate = selfSignedCertificate(directory);

    expect(certificate.certFile.startsWith(directory)).toBe(true);
    expect(readFileSync(certificate.certFile, 'utf8')).toContain('BEGIN CERTIFICATE');
    expect(readFileSync(certificate.keyFile, 'utf8')).toContain('PRIVATE KEY');
  });

  it('throws rather than handing back files that were never written', () => {
    expect(() => selfSignedCertificate(scratch(), 'holydeck-no-such-openssl')).toThrow();
  });

  it('names both files to the application, which refuses one without the other', () => {
    expect(tlsEnvironment({ certFile: '/c.pem', keyFile: '/k.pem' })).toEqual({
      HOLYDECK_TLS_CERT_FILE: '/c.pem',
      HOLYDECK_TLS_KEY_FILE: '/k.pem',
    });
  });
});
