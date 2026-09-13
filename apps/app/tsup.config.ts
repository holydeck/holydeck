import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/migrate.ts', 'src/settings.ts', 'src/boot.ts', 'src/queue.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  dts: { entry: ['src/settings.ts', 'src/boot.ts', 'src/queue.ts'] },
  sourcemap: true,
  clean: true,
});
