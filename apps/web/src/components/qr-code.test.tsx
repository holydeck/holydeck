// @vitest-environment happy-dom
import { render, screen } from '@testing-library/preact';
import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';

import { QrCode } from './qr-code.js';

describe('QrCode', () => {
  it('draws one dark square per dark module, inside the quiet zone, and names itself for a screen reader', () => {
    const value = 'otpauth://totp/HolyDeck:ruth?secret=JBSWY3DPEHPK3PXP&issuer=HolyDeck';
    render(<QrCode value={value} label="Scan me" />);
    const picture = screen.getByRole('img', { name: 'Scan me' });
    const { data, size } = encode(value, { ecc: 'M', border: 4 });

    expect(picture.getAttribute('viewBox')).toBe(`0 0 ${size} ${size}`);
    const drawn = picture.querySelector('path')?.getAttribute('d')?.match(/M/gu)?.length;
    expect(drawn).toBe(data.flat().filter(Boolean).length);
    // The quiet zone is never drawn on.
    expect(picture.querySelector('path')?.getAttribute('d')).not.toMatch(/M[0-3] /u);
  });
});
