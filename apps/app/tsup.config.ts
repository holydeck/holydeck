import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/settings.ts', 'src/boot.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  dts: { entry: ['src/settings.ts', 'src/boot.ts'] },
  sourcemap: true,
  clean: true,
});
