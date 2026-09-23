// A QR code drawn as one SVG path, so an authenticator app on a phone can take the enrolment secret from
// the screen instead of having it typed (COLAB-06). The encoding comes from `uqr`; the drawing stays here,
// as plain elements rather than markup handed to `innerHTML`, and dark on light whatever the theme is:
// a scanner reads contrast, and an inverted code is one some of them refuse.

import { encode } from 'uqr';

import type { JSX } from 'preact';

/** The quiet zone around the code, in modules. Four is what the QR specification asks for. */
const BORDER = 4;

export interface QrCodeProps {
  readonly value: string;
  /** What a screen reader says in place of the picture. */
  readonly label: string;
}

/** `value` as a scannable QR code, with error correction at M so a slightly blurred camera still reads it. */
export function QrCode({ value, label }: QrCodeProps): JSX.Element {
  const { data, size } = encode(value, { ecc: 'M', border: BORDER });
  const modules: string[] = [];
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) modules.push(`M${x} ${y}h1v1h-1z`);
    });
  });
  return (
    <svg class="qr-code" role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shape-rendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={modules.join('')} fill="#000000" />
    </svg>
  );
}
