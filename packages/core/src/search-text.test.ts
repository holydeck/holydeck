import { describe, expect, it } from 'vitest';

import { foldSearchText } from './search-text.js';

describe('foldSearchText', () => {
  it('normalizes Tamil-script text to NFC regardless of input decomposition', () => {
    const nfc = 'தொழுவோம்'.normalize('NFC');
    const nfd = 'தொழுவோம்'.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    expect(foldSearchText(nfc)).toBe(foldSearchText(nfd));
  });

  it('case- and diacritic-folds Romanized text', () => {
    expect(foldSearchText('Amma')).toBe(foldSearchText('amma'));
    expect(foldSearchText('café')).toBe(foldSearchText('cafe'));
  });

  it('does not transliterate a Romanized spelling onto its Tamil-script equivalent', () => {
    expect(foldSearchText('அம்மா')).not.toBe(foldSearchText('amma'));
  });
});
