// P-26: what a slide gets when nothing supplies a layout — one text box at the safe-area frame, set in
// whichever font stack matches the block's own language. Numeric defaults (size, weight, leading) are
// this file's own placeholders, not a spec'd number: nothing in the plan or LANG-02 sets one for a box
// with no layout to inherit sizing from.

import type { FontSpec, NormalizedFrame, TextBox } from '@holydeck/renderer/render-model';
import type { SafeAreaMargins } from '@holydeck/renderer/output-profile';

const FALLBACK_FONT: Omit<FontSpec, 'family'> = { weight: 400, sizeRatio: 0.08, lineHeight: 1.3 };

/** The frame between the safe-area margins — the only area a fallback box is ever placed in. */
export function fallbackFrame(safeArea: SafeAreaMargins): NormalizedFrame {
  return {
    x: safeArea.left,
    y: safeArea.top,
    width: Math.max(0, 1 - (safeArea.left + safeArea.right)),
    height: Math.max(0, 1 - (safeArea.top + safeArea.bottom)),
  };
}

/** One required text box, sized to the safe area, in `--font-tamil` for Tamil text and `--font-latin`
 *  for everything else (LANG-02). */
export function fallbackLayout(id: string, text: string, language: string, safeArea: SafeAreaMargins): TextBox {
  return {
    id,
    kind: 'text',
    text,
    frame: fallbackFrame(safeArea),
    font: { ...FALLBACK_FONT, family: language === 'ta' ? 'var(--font-tamil)' : 'var(--font-latin)' },
    importance: 'required',
  };
}
