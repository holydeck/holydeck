import { describe, expect, it } from 'vitest';

import { LOCALES, type Locale } from './locales.js';
import {
  MESSAGE_KEYS,
  MESSAGES,
  MessageError,
  type MessageKey,
  translate,
  translateCount,
} from './messages.js';

// The rule stated here rather than imported: a test that borrows the implementation's own regular
// expression agrees with it by construction.
const placeholdersIn = (template: string): readonly string[] =>
  [...template.matchAll(/\{([a-z][A-Za-z0-9]*)\}/gu)].map((match) => match[1] ?? '').sort();

// The compiler refuses both of these, which is the point: a key or a locale can only be wrong here if
// it arrived as data or from a caller written in JavaScript, and that is the case these guards are for.
const asKey = (key: string): MessageKey => key as unknown as MessageKey;
const asLocale = (locale: string): Locale => locale as unknown as Locale;

const everyLocaleAndKey = LOCALES.flatMap((locale) => MESSAGE_KEYS.map((key) => [locale, key] as const));

describe('message identifiers', () => {
  it('are one sorted set that every catalog carries, so changing locale never changes an identifier', () => {
    expect(MESSAGE_KEYS.length).toBeGreaterThan(0);
    expect([...MESSAGE_KEYS]).toEqual([...MESSAGE_KEYS].sort());
    expect(Object.isFrozen(MESSAGE_KEYS)).toBe(true);
    for (const locale of LOCALES) {
      expect(Object.keys(MESSAGES[locale]).sort()).toEqual([...MESSAGE_KEYS]);
    }
  });

  it('name a counted message in both of its variants, never only one', () => {
    const counted = MESSAGE_KEYS.filter((key) => key.endsWith('.one'));
    expect(counted.length).toBeGreaterThan(0);
    for (const key of counted) {
      expect(MESSAGE_KEYS).toContain(key.replace(/\.one$/u, '.other'));
    }
  });
});

describe('the catalogs', () => {
  it('ship a locale for every locale the product claims', () => {
    expect(Object.keys(MESSAGES).sort()).toEqual([...LOCALES].sort());
  });

  it('hold copy somebody can read: nothing empty, nothing padded', () => {
    for (const [locale, key] of everyLocaleAndKey) {
      const message = MESSAGES[locale][key];
      expect(message).not.toBe('');
      expect(message).toBe(message.trim());
    }
  });

  it('ask each locale for the same values, so one caller serves them all', () => {
    for (const [locale, key] of everyLocaleAndKey) {
      expect(placeholdersIn(MESSAGES[locale][key])).toEqual(placeholdersIn(MESSAGES.en[key]));
    }
  });

  // The usual way a locale goes missing is a copied English catalog nobody came back to.
  it('say something other than the English for every key', () => {
    for (const [locale, key] of everyLocaleAndKey) {
      if (locale === 'en') continue;
      expect(MESSAGES[locale][key]).not.toBe(MESSAGES.en[key]);
    }
  });
});

// The service workspace added several hundred keys at once; this names its surfaces so a missing or
// copied string points at the screen it belongs to.
const WORKSPACE_PREFIXES = ['dashboard.', 'serviceNew.', 'workspace.', 'order.', 'bulk.', 'lifecycle.', 'drift.', 'output.',
  'preview.', 'add.', 'bible.', 'blank.', 'reading.', 'canvas.', 'song.', 'slides.', 'sermon.', 'media.', 'mediaLib.',
  'library.', 'readiness.', 'editor.', 'service.state.'] as const;

describe('the service workspace strings', () => {
  it.each(['de', 'ta'] as const)('are all translated into %s, with the same placeholders', (locale) => {
    for (const prefix of WORKSPACE_PREFIXES) {
      const keys = MESSAGE_KEYS.filter((key) => key.startsWith(prefix));
      expect(keys.length, prefix).toBeGreaterThan(0);
      for (const key of keys) {
        expect(MESSAGES[locale][key], key).not.toBe(MESSAGES.en[key]);
        expect(placeholdersIn(MESSAGES[locale][key]), key).toEqual(placeholdersIn(MESSAGES.en[key]));
      }
    }
  });

  it('address the reader formally in German, as the rest of the catalog does', () => {
    for (const key of MESSAGE_KEYS.filter((candidate) => WORKSPACE_PREFIXES.some((prefix) => candidate.startsWith(prefix)))) {
      expect(MESSAGES.de[key], key).not.toMatch(/\b(du|dein|deine|dir|dich)\b/u);
    }
  });
});

// v1c-14 added the admin operations screens (Jobs, Operations, Backups + restore, the notification bell
// and its preferences page) and the run review/recap screen in one pass, each with its own key prefix;
// censused the same way WORKSPACE_PREFIXES censuses the service workspace above.
const ADMIN_OPS_PREFIXES = [
  'jobs.', 'operations.', 'backups.', 'notifications.', 'account.notifications.', 'run.',
] as const;

describe('the admin operations strings', () => {
  it.each(['de', 'ta'] as const)('are all translated into %s, with the same placeholders', (locale) => {
    for (const prefix of ADMIN_OPS_PREFIXES) {
      const keys = MESSAGE_KEYS.filter((key) => key.startsWith(prefix));
      expect(keys.length, prefix).toBeGreaterThan(0);
      for (const key of keys) {
        expect(MESSAGES[locale][key], key).not.toBe(MESSAGES.en[key]);
        expect(placeholdersIn(MESSAGES[locale][key]), key).toEqual(placeholdersIn(MESSAGES.en[key]));
      }
    }
  });

  it('address the reader formally in German, as the rest of the catalog does', () => {
    for (const key of MESSAGE_KEYS.filter((candidate) => ADMIN_OPS_PREFIXES.some((prefix) => candidate.startsWith(prefix)))) {
      expect(MESSAGES.de[key], key).not.toMatch(/\b(du|dein|deine|dir|dich)\b/u);
    }
  });
});

describe('translating', () => {
  it('names run and theme outcomes in every shipped locale', () => {
    const keys = [
      'error.run.not_ready',
      'error.run.snapshot_outdated',
      'error.run.already_active',
      'error.run.ended',
      'error.theme.contrast',
      'live.run.started',
      'live.run.ended',
      'live.mode.paused',
      'live.mode.standby',
      'live.mode.live',
      'live.error.stale',
      'live.error.unauthorized',
      'live.error.invalid',
      'live.error.failed',
    ] as const;
    for (const locale of LOCALES) {
      for (const key of keys) expect(translate(locale, key)).not.toBe('');
    }
  });

  it('renders the copy of the locale it was asked for', () => {
    expect(translate('en', 'shell.preparing')).toBe('Preparing the service view.');
    expect(translate('de', 'shell.preparing')).toBe('Die Gottesdienstansicht wird vorbereitet.');
    expect(translate('ta', 'shell.preparing')).toBe('வழிபாட்டுக் காட்சி தயாராகிறது.');
  });

  it('names each output channel and its launch outcomes in every shipped locale', () => {
    expect(translate('en', 'output.channel.audience')).toBe('Audience');
    expect(translate('de', 'output.channel.audience')).toBe('Publikum');
    expect(translate('ta', 'output.channel.audience')).toBe('பார்வையாளர்');

    expect(translate('en', 'output.launch.screen', { view: 'Stage' })).toBe(
      'Stage opened on its assigned screen.',
    );
    expect(translate('de', 'output.launch.screen', { view: 'Bühne' })).toBe(
      'Bühne wurde auf dem zugewiesenen Bildschirm geöffnet.',
    );
    expect(translate('ta', 'output.launch.screen', { view: 'மேடை' })).toBe(
      'மேடை அதற்கான திரையில் திறக்கப்பட்டது.',
    );

    expect(translate('en', 'output.launch.blocked', { view: 'Singer' })).toContain('blocked');
    expect(translate('de', 'output.launch.blocked', { view: 'Sänger' })).toContain('Popup-Blockierung');
    expect(translate('ta', 'output.launch.blocked', { view: 'பாடகர்' })).toContain('பாப்-அப்');
  });

  it('names the output profile ratio and its source in every shipped locale', () => {
    expect(translate('en', 'output.ratio', { ratio: '16:9' })).toBe('Aspect ratio: 16:9');
    expect(translate('de', 'output.ratio', { ratio: '16:9' })).toBe('Seitenverhältnis: 16:9');
    expect(translate('ta', 'output.ratio', { ratio: '16:9' })).toBe('பக்க விகிதம்: 16:9');

    expect(translate('en', 'output.source.default')).toBe('(default)');
    expect(translate('en', 'output.source.service')).toBe('(this service)');
    expect(translate('de', 'output.source.default')).not.toBe(translate('en', 'output.source.default'));
    expect(translate('ta', 'output.source.service')).not.toBe(translate('en', 'output.source.service'));

    expect(translate('en', 'output.locked')).toContain('presenting');
    expect(translate('de', 'output.locked')).not.toBe(translate('en', 'output.locked'));
    expect(translate('ta', 'output.locked')).not.toBe(translate('en', 'output.locked'));
  });

  it('formats a number it is given in the locale it is rendering', () => {
    expect(translate('en', 'service.slideCount.other', { count: 1234 })).toBe('1,234 slides');
    expect(translate('de', 'service.slideCount.other', { count: 1234 })).toBe('1.234 Folien');
    expect(translate('ta', 'service.slideCount.other', { count: 123456 })).toBe('1,23,456 ஸ்லைடுகள்');
  });

  it('takes a value that is already text as it stands', () => {
    expect(translate('en', 'service.slideCount.other', { count: 'no' })).toBe('no slides');
  });

  it('never renders an identifier where copy belongs', () => {
    for (const [locale, key] of everyLocaleAndKey) {
      const values = Object.fromEntries(placeholdersIn(MESSAGES[locale][key]).map((name) => [name, 'x']));
      const rendered = translate(locale, key, values);
      expect(rendered).not.toContain(key);
      expect(rendered).not.toMatch(/[{}]/u);
    }
  });

  it('refuses a message nobody wrote instead of rendering its name', () => {
    const absent = asKey('shell.absent');
    expect(() => translate('en', absent)).toThrow(MessageError);
    expect(() => translate('en', absent)).toThrow(/shell.absent/u);
  });

  it('refuses a locale nobody ships', () => {
    expect(() => translate(asLocale('fr'), 'shell.preparing')).toThrow(/fr/u);
  });

  it('refuses a value the message needs and nobody passed', () => {
    expect(() => translate('en', 'service.slideCount.other')).toThrow(/needs a value for \{count\}/u);
  });

  it('refuses a value the message has no place for, which is how a renamed placeholder is caught', () => {
    expect(() => translate('en', 'shell.preparing', { count: 1 })).toThrow(/no place for \{count\}/u);
  });
});

describe('translating a count', () => {
  it('picks the variant the locale asks for and formats the number in it', () => {
    expect(translateCount('en', 'service.slideCount', 1)).toBe('1 slide');
    expect(translateCount('en', 'service.slideCount', 2)).toBe('2 slides');
    expect(translateCount('en', 'service.slideCount', 1234)).toBe('1,234 slides');
    expect(translateCount('de', 'service.slideCount', 1)).toBe('1 Folie');
    expect(translateCount('de', 'service.slideCount', 2)).toBe('2 Folien');
    expect(translateCount('de', 'service.slideCount', 1234)).toBe('1.234 Folien');
    expect(translateCount('ta', 'service.slideCount', 1)).toBe('1 ஸ்லைடு');
    expect(translateCount('ta', 'service.slideCount', 2)).toBe('2 ஸ்லைடுகள்');
    expect(translateCount('ta', 'service.slideCount', 123456)).toBe('1,23,456 ஸ்லைடுகள்');
  });

  it('counts zero as many, in every locale that ships', () => {
    expect(translateCount('en', 'service.slideCount', 0)).toBe('0 slides');
    expect(translateCount('de', 'service.slideCount', 0)).toBe('0 Folien');
    expect(translateCount('ta', 'service.slideCount', 0)).toBe('0 ஸ்லைடுகள்');
  });
});
