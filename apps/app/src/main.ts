import { readFileSync } from 'node:fs';

import { buildApp } from './app.js';
import { checkReleasedContracts, readSettingsText } from './boot.js';
import { loadSettings, settingsPath } from './settings.js';

checkReleasedContracts();

const path = settingsPath(process.env);
const settings = loadSettings({
  fileText: readSettingsText((file) => readFileSync(file, 'utf8'), path),
  env: process.env,
  path,
});

const app = buildApp({ settings, logger: { level: process.env.HOLYDECK_LOG_LEVEL ?? 'info' } });

for (const [key, source] of Object.entries(settings.sources)) {
  app.log.info(`${key} came from the ${source}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}

// Containers reach the service through the published port, so the listener cannot be loopback-only.
await app.listen({ host: '0.0.0.0', port: settings.values.port });
