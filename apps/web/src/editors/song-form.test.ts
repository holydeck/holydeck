import type { SongBody } from '@holydeck/contracts/songs';
import { describe, expect, it } from 'vitest';

import { EMPTY_SONG_FORM, fromForm, toForm } from './song-form.js';

const tamilAndLatin: SongBody = {
  titles: { tamil: 'கர்த்தர் என் மேய்ப்பர்', romanized: 'Karththar En Meyppar' },
  languages: ['ta', 'ta-Latn'],
  sections: [
    { id: 'v1', label: 'Verse 1', text: [{ languageKey: 'ta', text: 'கர்த்தர்\nஎன்' }, { languageKey: 'ta-Latn', text: 'Karththar\nen' }] },
    { id: 'c', label: 'Chorus', repeat: { count: 3 }, text: [{ languageKey: 'ta', text: 'அல்லேலூயா' }] },
  ],
  provenance: { source: 'manual' },
  metadata: { author: 'A. Writer', copyright: 'Public domain' },
};

const imported: SongBody = {
  titles: { tamil: 'பாடல்', romanized: 'Paadal' },
  languages: ['ta-Latn'],
  sections: [],
  provenance: { source: 'import', importer: 'powerpoint', importedAt: '2026-09-01T00:00:00.000Z', reference: 'deck.pptx' },
};

describe('song form', () => {
  it.each([['Tamil and Latin with a repeat and details', tamilAndLatin], ['imported, no details', imported]])(
    'round-trips %s unchanged',
    (_name, body) => {
      expect(fromForm(toForm(body))).toEqual(body);
    },
  );

  it('reads a repeat as a count and a missing repeat as once', () => {
    const form = toForm(tamilAndLatin);
    expect(form.sections.map((section) => section.repeat)).toEqual([1, 3]);
    expect(form.sections[0]?.text).toEqual({ ta: 'கர்த்தர்\nஎன்', 'ta-Latn': 'Karththar\nen' });
  });

  it('drops a repeat below two, empty details, and text for a language the song no longer declares', () => {
    const body = fromForm({
      ...EMPTY_SONG_FORM,
      titleTamil: 'x',
      languages: ['ta'],
      sections: [{ id: 's', label: 'Verse', repeat: 1, text: { ta: 'a', en: 'gone' } }],
      metadata: { author: '', copyright: 'c', tempo: 'ignored' },
    });
    expect(body.sections).toEqual([{ id: 's', label: 'Verse', text: [{ languageKey: 'ta', text: 'a' }] }]);
    expect(body.metadata).toEqual({ copyright: 'c' });
    expect(fromForm(EMPTY_SONG_FORM)).not.toHaveProperty('metadata');
  });
});
