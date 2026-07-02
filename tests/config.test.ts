import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolveConfig } from '../src/config.js';

const tempCwd = path.resolve('fixtures/next-app');
const configPath = path.join(tempCwd, 'routier.json');

test('loadConfig returns null when routier.json does not exist', async () => {
  await rm(configPath, { force: true });
  
  const config = await loadConfig(tempCwd);
  assert.equal(config, null);
});

test('loadConfig parses and returns configuration when routier.json exists', async () => {
  const mockConfig = {
    framework: 'next',
    out: './custom-out',
    baseUrl: 'http://test-url',
    exclude: ['**/test-ignore/**'],
  };
  
  await writeFile(configPath, JSON.stringify(mockConfig, null, 2), 'utf-8');
  
  try {
    const config = await loadConfig(tempCwd);
    assert.deepEqual(config, mockConfig);
  } finally {
    await rm(configPath, { force: true });
  }
});

test('resolveConfig merges CLI options and configuration file, prioritizing CLI', async () => {
  const mockConfig = {
    framework: 'next',
    out: './json-out',
    baseUrl: 'http://json-url',
    format: 'postman' as const,
  };
  
  await writeFile(configPath, JSON.stringify(mockConfig, null, 2), 'utf-8');
  
  try {
    const cliOptions = {
      out: './cli-out',
      baseUrl: 'http://cli-url',
    };
    
    const resolved = await resolveConfig(tempCwd, cliOptions);
    
    assert.equal(resolved.framework, 'next');
    assert.equal(resolved.format, 'postman');
    assert.equal(resolved.out, './cli-out');
    assert.equal(resolved.baseUrl, 'http://cli-url');
  } finally {
    await rm(configPath, { force: true });
  }
});
