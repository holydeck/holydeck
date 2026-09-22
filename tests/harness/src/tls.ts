// A certificate for a stack that has to be reached over HTTPS. The session cookie is `__Host-`-prefixed,
// so it is always `Secure`, and a browser only keeps a `Secure` cookie from an HTTPS origin: a browser run
// that signs in through the page therefore needs the application to speak TLS, exactly as a deployment
// does behind its own certificate. The certificate is made per run, for the loopback address the stack
// listens on, and thrown away with the stack's data directory.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export interface Certificate {
  /** The PEM certificate, which is also the authority a Node client trusts to reach the stack. */
  readonly certFile: string;
  readonly keyFile: string;
}

/** Writes a one-day self-signed certificate for `127.0.0.1` and `localhost` into `directory`. */
export function selfSignedCertificate(directory: string, openssl = 'openssl'): Certificate {
  const certFile = join(directory, 'tls-cert.pem');
  const keyFile = join(directory, 'tls-key.pem');
  execFileSync(
    openssl,
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    // OpenSSL narrates key generation on stderr; a failure still throws with its status and output.
    { stdio: 'pipe' },
  );
  return { certFile, keyFile };
}

/** What the application reads to listen with the certificate instead of over plain HTTP. */
export function tlsEnvironment(certificate: Certificate): Record<string, string> {
  return {
    HOLYDECK_TLS_CERT_FILE: certificate.certFile,
    HOLYDECK_TLS_KEY_FILE: certificate.keyFile,
  };
}
