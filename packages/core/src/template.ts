import { Liquid } from 'liquidjs';
import { HolyDeckError, formatMessage } from './messages.js';

export interface PassageData {
  translation: string;
  book: string;
  bookName: string;
  chapter: number;
  verses: string;
  text: string;
  citation: string;
  revision: number;
  fetchedAt: string;
}

export interface EntryData {
  reference: string;
  passages: PassageData[];
}

export const DEFAULT_TEMPLATE = [
  '{% for entry in entries %}{% for passage in entry.passages %}{{ passage.text }}',
  '{{ passage.citation }} ({{ passage.translation }})',
  '',
  '{% endfor %}{% endfor %}',
].join('\n');

export const LEGACY_DEFAULT_TEMPLATE = '{0.passage}\n{0.book} {0.chapter}:{0.verses}\n\n';

const LEGACY_FIELD = /\{(\d+)\.(passage|book|chapter|verses|citation)\}/g;

export function isLegacyTemplate(template: string): boolean {
  return new RegExp(LEGACY_FIELD.source).test(template);
}

export function renderLegacyTemplate(template: string, entries: EntryData[]): string {
  return entries
    .map((entry) =>
      template.replace(new RegExp(LEGACY_FIELD.source, 'g'), (_match, indexDigits: string, field: string) => {
        const index = Number(indexDigits);
        const passage = entry.passages[index];
        if (passage === undefined) {
          throw new HolyDeckError('template_index_out_of_range', { index, count: entry.passages.length });
        }
        if (field === 'passage') return passage.text;
        if (field === 'book') return passage.bookName;
        if (field === 'chapter') return String(passage.chapter);
        if (field === 'verses') return passage.verses;
        return passage.citation;
      }),
    )
    .join('');
}

const liquid = new Liquid();

export async function renderOutput(
  template: string | undefined,
  entries: EntryData[],
  notices?: string[],
): Promise<string> {
  if (template !== undefined && isLegacyTemplate(template)) {
    notices?.push(formatMessage('legacy_template'));
    return renderLegacyTemplate(template, entries);
  }
  try {
    return (await liquid.parseAndRender(template ?? DEFAULT_TEMPLATE, { entries })) as string;
  } catch (error) {
    if (error instanceof HolyDeckError) throw error;
    throw new HolyDeckError('template_invalid', { reason: (error as Error).message });
  }
}
