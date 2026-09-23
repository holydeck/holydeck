// @vitest-environment happy-dom

import { render, screen } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

import type { RenderFrame } from '@holydeck/renderer/renderer';

import { SafeAreaOverlay } from './SafeAreaOverlay.js';

const frame: RenderFrame = {
  modelId: 'm1',
  outputType: 'audience',
  aspectRatio: { width: 16, height: 9 },
  canvas: { width: 1920, height: 1080 },
  safeArea: { x: 96, y: 54, width: 1728, height: 972 },
  minimumFontSizePx: 10,
  slides: [],
  findings: [],
  readiness: 'ready',
};

describe('SafeAreaOverlay', () => {
  it('positions the dashed rectangle at frame.safeArea, scaled', () => {
    const { container } = render(<SafeAreaOverlay frame={frame} scale={0.5} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.left).toBe('48px');
    expect(box.style.top).toBe('27px');
    expect(box.style.width).toBe('864px');
    expect(box.style.height).toBe('486px');
    expect(box.style.borderStyle).toBe('dashed');
  });

  it('shows the safe-area legend', () => {
    render(<SafeAreaOverlay frame={frame} scale={0.5} />);
    expect(screen.getByText('Dashed line: safe area')).toBeTruthy();
  });
});
