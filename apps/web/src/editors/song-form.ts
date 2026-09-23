// The Song editor's form model and the song body it stands for. The form is shaped for editing — a repeat
// is a plain number, one text per language per section, details as key and value — while the body is
// spec 02's `SongBody`, exactly what the server stores. The two maps are pure and each other's inverse,
// so opening a song and saving it untouched never changes a byte of it.

import { METADATA_KEYS, SMALLEST_REPEAT, type LyricSection, type SongBody, type SongMetadata, type SongProvenance } from '@holydeck/contracts/songs';

/** One section as the form edits it: `repeat` is how many times it is sung, 1 meaning once. */
export type SongFormSection = {
  readonly id: string;
  readonly label: string;
  readonly repeat: number;
  readonly text: Readonly<Record<string, string>>;
};

/** Everything the Song editor's Form tab edits, plus the provenance it only shows. */
export type SongForm = {
  readonly titleTamil: string;
  readonly titleRomanized: string;
  readonly languages: readonly string[];
  readonly sections: readonly SongFormSection[];
  readonly metadata: Readonly<Record<string, string>>;
  readonly provenance: SongProvenance;
};

/** The form a new song starts from: nothing written yet, typed in by hand. */
export const EMPTY_SONG_FORM: SongForm = {
  titleTamil: '', titleRomanized: '', languages: [], sections: [], metadata: {}, provenance: { source: 'manual' },
};

/** A song body as the form edits it. */
export function toForm(body: SongBody): SongForm {
  return {
    titleTamil: body.titles.tamil,
    titleRomanized: body.titles.romanized,
    languages: [...body.languages],
    sections: body.sections.map((section) => ({
      id: section.id,
      label: section.label,
      repeat: section.repeat?.count ?? 1,
      text: Object.fromEntries(section.text.map((entry) => [entry.languageKey, entry.text])),
    })),
    metadata: { ...body.metadata },
    provenance: body.provenance,
  };
}

const sectionFrom = (section: SongFormSection, languages: readonly string[]): LyricSection => ({
  id: section.id,
  label: section.label,
  ...(section.repeat >= SMALLEST_REPEAT ? { repeat: { count: section.repeat } } : {}),
  // In the song's own language order; a language the song no longer declares is left behind.
  text: languages.flatMap((languageKey) => {
    const text = section.text[languageKey];
    return text === undefined ? [] : [{ languageKey, text }];
  }),
});

/** The song body the form stands for. Empty details are left out rather than saved as empty text. */
export function fromForm(form: SongForm): SongBody {
  const metadata: Record<string, string> = {};
  for (const key of METADATA_KEYS) {
    const value = form.metadata[key];
    if (value !== undefined && value !== '') metadata[key] = value;
  }
  return {
    titles: { tamil: form.titleTamil, romanized: form.titleRomanized },
    languages: [...form.languages],
    sections: form.sections.map((section) => sectionFrom(section, form.languages)),
    provenance: form.provenance,
    ...(Object.keys(metadata).length === 0 ? {} : { metadata: metadata as SongMetadata }),
  };
}
