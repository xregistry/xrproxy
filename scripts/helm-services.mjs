#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest, selectServices, validateManifest } from './service-manifest.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const valuesPath = resolve(root, 'charts', 'xrproxy', 'values.yaml');
const startMarker = '# BEGIN GENERATED SERVICES - run: npm run helm:services:generate';
const endMarker = '# END GENERATED SERVICES';

function quote(value) {
  return JSON.stringify(String(value));
}

function imageFor(service) {
  return service.images.find(image => image.id === service.id) ?? service.images[0];
}

function cacheMountPath(service) {
  return service.role === 'bridge' ? '/app/cache' : `/app/${service.directory}/cache`;
}

export function renderHelmServices(manifest = validateManifest(loadManifest())) {
  const active = selectServices(manifest, { status: 'active' });
  const lines = ['services:'];

  for (const service of active) {
    const image = imageFor(service);
    lines.push(`  ${service.id}:`);
    lines.push('    enabled: true');
    lines.push(`    role: ${service.role}`);
    lines.push(`    directory: ${service.directory}`);
    lines.push('    image:');
    lines.push(`      repository: ${image.name}`);
    lines.push('      tag: ""');
    lines.push('      digest: ""');
    lines.push(`    port: ${service.port}`);
    lines.push(`    healthPath: ${service.deployment.healthPath}`);
    lines.push(`    readinessPath: ${service.deployment.readinessPath}`);
    lines.push(`    replicas: ${service.deployment.replicas}`);
    lines.push('    environment:');
    for (const [name, value] of Object.entries(service.environment).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`      ${name}: ${quote(value)}`);
    }
    lines.push('    resources:');
    lines.push('      requests:');
    lines.push(`        cpu: ${service.deployment.cpu}`);
    lines.push(`        memory: ${service.deployment.memory}`);
    lines.push('      limits:');
    lines.push(`        cpu: ${service.deployment.cpu}`);
    lines.push(`        memory: ${service.deployment.memory}`);
    lines.push('    cache:');
    lines.push('      enabled: true');
    lines.push(`      mountPath: ${cacheMountPath(service)}`);
    lines.push('      sizeLimit: ""');
    lines.push('    autoscaling:');
    lines.push('      enabled: false');
    lines.push(`      minReplicas: ${service.deployment.replicas}`);
    lines.push('      maxReplicas: 3');
    lines.push('      targetCPUUtilizationPercentage: 75');
  }

  return lines.join('\n');
}

function replaceGeneratedBlock(values, generated) {
  const start = values.indexOf(startMarker);
  const end = values.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not find generated service markers in ${valuesPath}`);
  }
  const contentStart = start + startMarker.length;
  return `${values.slice(0, contentStart)}\n${generated}\n${values.slice(end)}`;
}

export function expectedValues(values = readFileSync(valuesPath, 'utf8')) {
  return replaceGeneratedBlock(values, renderHelmServices());
}

function main() {
  const command = process.argv[2] ?? 'check';
  const current = readFileSync(valuesPath, 'utf8');
  const expected = expectedValues(current);

  if (command === 'generate') {
    writeFileSync(valuesPath, expected);
    console.log('Updated charts/xrproxy/values.yaml from config/services.json');
    return;
  }
  if (command === 'check') {
    if (current !== expected) {
      throw new Error('charts/xrproxy/values.yaml is out of date; run npm run helm:services:generate');
    }
    console.log('Helm service values match config/services.json');
    return;
  }
  throw new Error('Usage: helm-services.mjs check|generate');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
