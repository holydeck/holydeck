// The dashed rectangle a producer checks a slide's text and media against before presenting — drawn at
// `frame.safeArea`, the one safe-area rect `renderPrepared` resolved for the whole slide (REND-01 keeps
// this outside any per-box decision).

import type { JSX } from 'preact';

import type { RenderFrame } from '@holydeck/renderer/renderer';

import { t } from '../i18n.js';

export interface SafeAreaOverlayProps {
  readonly frame: RenderFrame;
  readonly scale: number;
}

export function SafeAreaOverlay({ frame, scale }: SafeAreaOverlayProps): JSX.Element {
  const area = frame.safeArea;
  return (
    <div
      style={{
        position: 'absolute',
        left: `${area.x * scale}px`,
        top: `${area.y * scale}px`,
        width: `${area.width * scale}px`,
        height: `${area.height * scale}px`,
        boxSizing: 'border-box',
        border: '1px dashed currentColor',
        pointerEvents: 'none',
      }}
    >
      <span style={{ position: 'absolute', left: 0, top: 0, fontSize: '11px', lineHeight: 1, padding: '2px' }}>
        {t('preview.safeArea')}
      </span>
    </div>
  );
}
