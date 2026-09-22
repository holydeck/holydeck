// One place decides what a refused request says: every workspace mutation shows the same sentence for
// the same code instead of each call site inventing its own wording (P-28).

import { ENTITY_CONFLICT, VALIDATION_FAILED } from '@holydeck/contracts/http';
import type { MessageKey } from '@holydeck/localization/messages';

import { NETWORK_UNREACHABLE, type Refused } from './api.js';
import { t } from './i18n.js';

export function refusalKey(refused: Refused): MessageKey {
  if (refused.code === ENTITY_CONFLICT) return 'workspace.error.conflict';
  if (refused.code === NETWORK_UNREACHABLE) return 'form.error.network';
  if (refused.code === VALIDATION_FAILED) return 'form.error.summary';
  if (refused.code === 'media.derivative_missing') return 'preview.error.mediaMissing';
  return 'form.error.unexpected';
}

export function refusalText(refused: Refused): string {
  const key = refusalKey(refused);
  return key === 'form.error.unexpected' ? t(key, { code: refused.code }) : t(key);
}
