import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configFilePath, parseConfigFile } from '@holydeck/core/config';
import { renderOutput } from '@holydeck/core/template';
import { makeContext } from '../../test/harness.js';
import { runCli } from '../program.js';
import { TEMPLATE_EXAMPLE, configScaffold } from './config.js';

describe('configScaffold', () => {
  it('parses as a config file with KJV as the only active value', () => {
    const parsed = parseConfigFile(configScaffold(), 'scaffold');
    expect(parsed).toEqual({ defaultTranslations: ['KJV'] });
  });

  it('offers a template example that YAML and Liquid both accept', async () => {
    const parsed = parseConfigFile(`template: "${TEMPLATE_EXAMPLE}"`, 'scaffold');
    const passage = {
      translation: 'KJV',
      book: 'GEN',
      bookName: 'Genesis',
      chapter: 1,
      verses: '1',
      text: 'In the beginning God created the heaven and the earth.',
      citation: 'Genesis 1:1',
      revision: 1,
      fetchedAt: '2026-09-08',
    };
    const output = await renderOutput(parsed.template, [{ reference: 'GEN 1:1', passages: [passage] }]);
    expect(output).toBe('In the beginning God created the heaven and the earth.\nGenesis 1:1 (KJV)\n\n');
    expect(configScaffold()).toContain(`# template: "${TEMPLATE_EXAMPLE}"`);
  });

  it('documents every config key and its env var', () => {
    const text = configScaffold();
    for (const key of ['serverUrl', 'dataDir', 'template', 'defaultTranslations', 'syncConcurrency', 'syncDelayMs']) {
      expect(text).toContain(key);
    }
    for (const env of [
      'HOLYDECK_SERVER_URL',
      'HOLYDECK_DATA_DIR',
      'HOLYDECK_TEMPLATE',
      'HOLYDECK_TRANSLATIONS',
      'HOLYDECK_SYNC_CONCURRENCY',
      'HOLYDECK_SYNC_DELAY_MS',
    ]) {
      expect(text).toContain(env);
    }
  });
});

describe('config init', () => {
  it('writes the scaffold, creating parent directories, and prints the path', async () => {
    const setup = makeContext();
    const path = configFilePath(setup.ctx.platform);
    await expect(runCli(setup.ctx, ['config', 'init'])).resolves.toBe(0);
    expect(setup.stdout().trim()).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(configScaffold());
  });

  it('is picked up by the next runtime as a file-sourced value', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['config', 'init'])).resolves.toBe(0);
    await expect(runCli(setup.ctx, ['info'])).resolves.toBe(0);
    expect(setup.stdout()).toContain('defaultTranslations: KJV (file)');
  });

  it('refuses to overwrite without --force', async () => {
    const setup = makeContext();
    const path = configFilePath(setup.ctx.platform);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'defaultTranslations: [WEB]\n');
    await expect(runCli(setup.ctx, ['config', 'init'])).resolves.toBe(1);
    expect(setup.stderr()).toContain('pass --force to overwrite');
    expect(readFileSync(path, 'utf8')).toBe('defaultTranslations: [WEB]\n');
  });

  it('overwrites with --force', async () => {
    const setup = makeContext();
    const path = configFilePath(setup.ctx.platform);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'defaultTranslations: [WEB]\n');
    await expect(runCli(setup.ctx, ['config', 'init', '--force'])).resolves.toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(configScaffold());
  });

  it('errors on an unknown config subcommand', async () => {
    const setup = makeContext();
    await expect(runCli(setup.ctx, ['config', 'frobnicate'])).resolves.not.toBe(0);
    expect(existsSync(configFilePath(setup.ctx.platform))).toBe(false);
  });
});
