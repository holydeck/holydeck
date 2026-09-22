// The HTTP bodies that start a run or change it are settled here, so RUN-01, RUN-05, and RUN-08 have
// one wire shape every caller reads before the application decides what a run does with it.

import { LIBRARY_KINDS } from './library.js';
import { THEME_SURFACES, type ThemeSurface } from './live-theme.js';
import { FIELD_CODES, type ParseFn, type Parsed, parseObject } from './problems.js';

export const RUN_MODES = ['rehearsal', 'live'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export type RunStartOverride = { readonly reason: string };

export type RunStartBody = {
  readonly serviceId: string;
  readonly mode: RunMode;
  readonly override?: RunStartOverride;
};

const parseRunStartOverride: ParseFn<RunStartOverride> = (value, path) =>
  parseObject(value, path, (reader) => ({ reason: reader.text('reason') }));

export function parseRunStartBody(value: unknown): Parsed<RunStartBody> {
  return parseObject(value, 'run', (reader) => {
    const mode = reader.choice('mode', RUN_MODES);
    const override = reader.optionalParsed('override', parseRunStartOverride);
    if (mode !== 'live') reader.absent('override', FIELD_CODES.notAllowed, 'is not allowed for rehearsal');
    return { serviceId: reader.text('serviceId'), mode, ...(override === undefined ? {} : { override }) };
  });
}

export type RunThemeBody = { readonly surface: ThemeSurface; readonly theme: string };

export function parseRunThemeBody(value: unknown): Parsed<RunThemeBody> {
  return parseObject(value, 'run', (reader) => ({
    surface: reader.choice('surface', THEME_SURFACES),
    theme: reader.text('theme'),
  }));
}

export type RunAdditionBody = {
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly saveToLibrary?: boolean;
};

export function parseRunAdditionBody(value: unknown): Parsed<RunAdditionBody> {
  return parseObject(value, 'run', (reader) => {
    const saveToLibrary = reader.names.includes('saveToLibrary') ? reader.flag('saveToLibrary') : undefined;
    return {
      kind: reader.choice('kind', LIBRARY_KINDS),
      title: reader.text('title'),
      body: reader.text('body'),
      ...(saveToLibrary === undefined ? {} : { saveToLibrary }),
    };
  });
}
