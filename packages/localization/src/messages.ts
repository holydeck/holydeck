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
  'control.skipLinks.label': 'Skip links',
  'control.skip.order': 'Skip to Order',
  'control.skip.editorPreview': 'Skip to Editor and Preview',
  'control.skip.properties': 'Skip to Properties',
  'control.skip.liveControls': 'Skip to Live Controls',
  'control.region.order': 'Order',
  'control.region.editorPreview': 'Editor and Preview',
  'control.region.properties': 'Properties',
  'control.region.liveControls': 'Live Controls',
  'control.order.empty': 'No slides in this order yet.',
  'control.order.select': 'Show {label}',
  'control.editor.heading': 'Editor',
  'control.editor.empty': 'Nothing selected to edit yet.',
  'control.preview.heading': 'Preview',
  'control.preview.current': 'Current',
  'control.preview.next': 'Next',
  'control.preview.noNext': 'No next slide.',
  'control.preview.empty': 'Nothing to preview yet.',
  'control.properties.label': 'Label',
  'control.properties.empty': 'Select a slide to see its properties.',
  'control.live.previous': 'Previous slide',
  'control.live.next': 'Next slide',
  'control.status.showing': 'Now showing {label}.',
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
  'control.skipLinks.label': 'Sprungmarken',
  'control.skip.order': 'Zum Ablauf springen',
  'control.skip.editorPreview': 'Zu Editor und Vorschau springen',
  'control.skip.properties': 'Zu Eigenschaften springen',
  'control.skip.liveControls': 'Zur Live-Steuerung springen',
  'control.region.order': 'Ablauf',
  'control.region.editorPreview': 'Editor und Vorschau',
  'control.region.properties': 'Eigenschaften',
  'control.region.liveControls': 'Live-Steuerung',
  'control.order.empty': 'Noch keine Folien in diesem Ablauf.',
  'control.order.select': '{label} anzeigen',
  'control.editor.heading': 'Bearbeitung',
  'control.editor.empty': 'Noch nichts zum Bearbeiten ausgewählt.',
  'control.preview.heading': 'Vorschau',
  'control.preview.current': 'Aktuell',
  'control.preview.next': 'Nächste',
  'control.preview.noNext': 'Keine nächste Folie.',
  'control.preview.empty': 'Noch nichts zum Anzeigen.',
  'control.properties.label': 'Bezeichnung',
  'control.properties.empty': 'Wählen Sie eine Folie, um ihre Eigenschaften zu sehen.',
  'control.live.previous': 'Vorherige Folie',
  'control.live.next': 'Nächste Folie',
  'control.status.showing': 'Zeigt jetzt {label}.',
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
  'control.skipLinks.label': 'தாவல் இணைப்புகள்',
  'control.skip.order': 'வரிசைக்குச் செல்க',
  'control.skip.editorPreview': 'எடிட்டர் மற்றும் முன்னோட்டத்திற்குச் செல்க',
  'control.skip.properties': 'பண்புகளுக்குச் செல்க',
  'control.skip.liveControls': 'நேரடி கட்டுப்பாடுகளுக்குச் செல்க',
  'control.region.order': 'வரிசை',
  'control.region.editorPreview': 'எடிட்டர் மற்றும் முன்னோட்டம்',
  'control.region.properties': 'பண்புகள்',
  'control.region.liveControls': 'நேரடி கட்டுப்பாடுகள்',
  'control.order.empty': 'இந்த வரிசையில் இன்னும் ஸ்லைடுகள் இல்லை.',
  'control.order.select': '{label} காட்டு',
  'control.editor.heading': 'எடிட்டர்',
  'control.editor.empty': 'திருத்த எதுவும் தேர்ந்தெடுக்கப்படவில்லை.',
  'control.preview.heading': 'முன்னோட்டம்',
  'control.preview.current': 'தற்போதைய',
  'control.preview.next': 'அடுத்தது',
  'control.preview.noNext': 'அடுத்த ஸ்லைடு இல்லை.',
  'control.preview.empty': 'முன்னோட்டத்திற்கு எதுவும் இல்லை.',
  'control.properties.label': 'லேபிள்',
  'control.properties.empty': 'பண்புகளைக் காண ஒரு ஸ்லைடைத் தேர்ந்தெடுக்கவும்.',
  'control.live.previous': 'முந்தைய ஸ்லைடு',
  'control.live.next': 'அடுத்த ஸ்லைடு',
  'control.status.showing': 'இப்போது {label} காட்டப்படுகிறது.',
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
