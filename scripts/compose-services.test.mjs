import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateComposeFiles, validateComposeText } from './compose-services.mjs';

const manifest = JSON.parse(readFileSync(new URL('../config/services.json', import.meta.url), 'utf8'));

test('Compose files use canonical manifest ports', () => {
  assert.doesNotThrow(() => validateComposeFiles());
});

test('Compose validation rejects a swapped service port', () => {
  const source = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const invalid = source.replace('- "3100:3100"', '- "3000:3000"');
  assert.throws(
    () => validateComposeText(invalid, manifest.services, 'docker-compose.yml'),
    /npm must publish canonical port 3100/
  );
});
