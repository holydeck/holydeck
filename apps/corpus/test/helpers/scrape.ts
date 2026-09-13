export function chapterHtml(book: string, chapter: string, verses: Record<string, string>): string {
  const spans = Object.entries(verses)
    .map(
      ([verse, text]) =>
        `<span class="T__verse" data-usfm="${book}.${chapter}.${verse}"><span class="T__content">${text}</span></span>`,
    )
    .join('');
  return `<div class="chapter">${spans}</div>`;
}

export interface VersionBook {
  usfm: string;
  name: string;
  longName?: string;
  abbreviation?: string;
  chapters: string[];
}

export interface VersionLanguage {
  iso_639_1?: string;
  iso_639_3?: string;
  name?: string;
  local_name?: string;
  text_direction?: string;
  language_tag?: string;
}

export function versionPayload(
  options: {
    id?: number;
    abbreviation?: string;
    localTitle?: string;
    metadataBuild?: number;
    language?: VersionLanguage;
    books?: VersionBook[];
  } = {},
): string {
  const books = options.books ?? [{ usfm: 'PSA', name: 'Psalms', chapters: ['117'] }];
  return JSON.stringify({
    id: options.id ?? 1,
    abbreviation: options.abbreviation ?? 'KJV',
    local_title: options.localTitle ?? 'King James Version',
    metadata_build: options.metadataBuild ?? 51,
    language: options.language,
    books: books.map((book) => ({
      usfm: book.usfm,
      human: book.name,
      human_long: book.longName,
      abbreviation: book.abbreviation,
      canon: 'ot',
      text: true,
      chapters: book.chapters.map((chapter) => ({
        usfm: `${book.usfm}.${chapter}`,
        human: chapter,
        canonical: true,
      })),
    })),
  });
}
