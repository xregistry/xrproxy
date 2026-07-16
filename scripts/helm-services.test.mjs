import assert from 'node:assert/strict';
import test from 'node:test';

import { loadManifest, validateManifest } from './service-manifest.mjs';
import { renderHelmServices } from './helm-services.mjs';

test('Helm values contain exactly the active service inventory', () => {
  const manifest = validateManifest(loadManifest());
  const rendered = renderHelmServices(manifest);

  const renderedIds = [...rendered.matchAll(/^  ([a-z0-9-]+):$/gm)].map(match => match[1]);
  const activeIds = manifest.services
    .filter(service => service.status === 'active')
    .map(service => service.id);

  assert.deepEqual(renderedIds, activeIds);
});

test('Helm values preserve canonical ports and image names', () => {
  const manifest = validateManifest(loadManifest());
  const rendered = renderHelmServices(manifest);

  for (const service of manifest.services.filter(service => service.status === 'active')) {
    assert.match(rendered, new RegExp(`  ${service.id}:\\n[\\s\\S]*?    port: ${service.port}\\n`));
    const primaryImage = service.images.find(image => image.id === service.id) ?? service.images[0];
    assert.match(rendered, new RegExp(`      repository: ${primaryImage.name}\\n`));
  }
});
