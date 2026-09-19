// The copy every client renders, keyed by an identifier that does not change when the locale does.
//
// English is the source catalog: it declares the key set, and the other two are typed against it, so a
// key nobody translated is a compile error in this file rather than an identifier on a screen during a
// service. There is deliberately no per-key fallback to English at run time — that is the silent gap
// the missing-key rule exists to prevent, and a German screen with one English line reads as a bug
// nobody reported rather than one the build refused.

import { formatNumber, type PluralCategory, pluralCategory } from './format.js';
import type { Locale } from './locales.js';

const en = {
  'shell.preparing': 'Preparing the service view.',
  'service.slideCount.one': '{count} slide',
  'service.slideCount.other': '{count} slides',
  'output.channel.audience': 'Audience',
  'output.channel.stage': 'Stage',
  'output.channel.singer': 'Singer',
  'output.launch.screen': '{view} opened on its assigned screen.',
  'output.launch.manual':
    "{view} opened. Drag this window onto its screen, then use the display's own fullscreen control.",
  'output.launch.blocked': "{view} was blocked by the browser's popup policy. Click to open it.",
} as const;

export type MessageKey = keyof typeof en;

type Catalog = Readonly<Record<MessageKey, string>>;

const de: Catalog = {
  'shell.preparing': 'Die Gottesdienstansicht wird vorbereitet.',
  'service.slideCount.one': '{count} Folie',
  'service.slideCount.other': '{count} Folien',
  'output.channel.audience': 'Publikum',
  'output.channel.stage': 'Bühne',
  'output.channel.singer': 'Sänger',
  'output.launch.screen': '{view} wurde auf dem zugewiesenen Bildschirm geöffnet.',
  'output.launch.manual':
    '{view} wurde geöffnet. Ziehen Sie dieses Fenster auf seinen Bildschirm und nutzen Sie dann die Vollbildfunktion des Displays.',
  'output.launch.blocked': '{view} wurde von der Popup-Blockierung des Browsers verhindert. Zum Öffnen klicken.',
};

const ta: Catalog = {
  'shell.preparing': 'வழிபாட்டுக் காட்சி தயாராகிறது.',
  'service.slideCount.one': '{count} ஸ்லைடு',
  'service.slideCount.other': '{count} ஸ்லைடுகள்',
  'output.channel.audience': 'பார்வையாளர்',
  'output.channel.stage': 'மேடை',
  'output.channel.singer': 'பாடகர்',
  'output.launch.screen': '{view} அதற்கான திரையில் திறக்கப்பட்டது.',
  'output.launch.manual':
    '{view} திறக்கப்பட்டது. இந்த சாளரத்தை அதற்கான திரைக்கு இழுத்துச் சென்று, பின்னர் காட்சியின் முழுத்திரைக் கட்டுப்பாட்டைப் பயன்படுத்தவும்.',
  'output.launch.blocked': '{view} உலாவியின் பாப்-அப் கொள்கையால் தடுக்கப்பட்டது. திறக்க கிளிக் செய்யவும்.',
};

/** One catalog per shipped locale: adding a locale is a compile error until its copy exists. */
export const MESSAGES: Readonly<Record<Locale, Catalog>> = { en, de, ta };

// Object.keys is typed as string[] whatever it reads, and the sort is what makes the census below
// readable rather than dependent on the order somebody happened to type the catalog in.
export const MESSAGE_KEYS: readonly MessageKey[] = Object.freeze(
  (Object.keys(en) as MessageKey[]).sort(),
);

export type MessageValues = Readonly<Record<string, string | number>>;

/** Raised rather than returned: a message that cannot be rendered is a defect, not a value. */
export class MessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageError';
  }
}

// Widened views of the catalogs, so the two guards below can be written at all: indexing the narrow
// types can only ever produce a string, which is exactly the assumption a caller in JavaScript or a
// key that arrived as data breaks.
const CATALOGS: Readonly<Record<string, Catalog | undefined>> = MESSAGES;
const entriesOf = (catalog: Catalog): Readonly<Record<string, string | undefined>> => catalog;

const PLACEHOLDER = /\{([a-z][A-Za-z0-9]*)\}/gu;

/**
 * Renders one message. Every placeholder the copy names must have a value and every value passed must
 * have a placeholder, because a renamed placeholder is otherwise invisible: the old name silently
 * renders nothing and the new one silently goes unused.
 */
export function translate(locale: Locale, key: MessageKey, values: MessageValues = {}): string {
  const catalog = CATALOGS[locale];
  if (catalog === undefined) throw new MessageError(`there is no catalog for the locale ${locale}`);
  const template = entriesOf(catalog)[key];
  if (template === undefined) throw new MessageError(`there is no message named ${key}`);

  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new MessageError(`the message ${key} needs a value for {${name}}`);
    used.add(name);
    return typeof value === 'number' ? formatNumber(locale, value) : value;
  });
  for (const name of Object.keys(values)) {
    if (!used.has(name)) throw new MessageError(`the message ${key} has no place for {${name}}`);
  }
  return rendered;
}

type PrefixOf<Key, Suffix extends string> = Key extends `${infer Prefix}.${Suffix}` ? Prefix : never;

/** A message that ships one variant per plural category, named without the category. */
export type CountKey = PrefixOf<MessageKey, 'one'>;

// The compile-time half of the counted-message rule: this line stops typechecking if any counted
// message is missing a variant, because the template type it builds would then name a key nothing has.
const variantKey = (key: CountKey, category: PluralCategory): MessageKey => `${key}.${category}`;

/** Renders a counted message: the locale picks the variant, and the count is formatted in it. */
export function translateCount(
  locale: Locale,
  key: CountKey,
  count: number,
  values: MessageValues = {},
): string {
  return translate(locale, variantKey(key, pluralCategory(locale, count)), { ...values, count });
}
