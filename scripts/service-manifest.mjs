#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifestPath = resolve(root, 'config', 'services.json');

export function loadManifest() {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

function fail(message) {
  throw new Error(message);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty string`);
  }
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    fail(`${field} must be a positive integer`);
  }
}

export function validateManifest(manifest = loadManifest()) {
  if (manifest.schemaVersion !== 1) {
    fail(`Unsupported service manifest schemaVersion: ${manifest.schemaVersion}`);
  }
  if (!Array.isArray(manifest.services) || manifest.services.length === 0) {
    fail('services must be a non-empty array');
  }

  const ids = new Set();
  const ports = new Set();
  const groupTypes = new Set();
  const imageIds = new Set();

  for (const service of manifest.services) {
    requireString(service.id, 'service.id');
    requireString(service.name, `${service.id}.name`);
    requireString(service.role, `${service.id}.role`);
    requireString(service.status, `${service.id}.status`);
    requireString(service.directory, `${service.id}.directory`);

    if (!['proxy', 'bridge'].includes(service.role)) {
      fail(`${service.id}.role must be proxy or bridge`);
    }
    if (!['active', 'planned'].includes(service.status)) {
      fail(`${service.id}.status must be active or planned`);
    }
    if (ids.has(service.id)) {
      fail(`Duplicate service id: ${service.id}`);
    }
    ids.add(service.id);

    if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
      fail(`${service.id}.port must be an integer between 1 and 65535`);
    }
    if (ports.has(service.port)) {
      fail(`Duplicate service port: ${service.port}`);
    }
    ports.add(service.port);

    if (!Array.isArray(service.groupTypes)) {
      fail(`${service.id}.groupTypes must be an array`);
    }
    for (const groupType of service.groupTypes) {
      requireString(groupType, `${service.id}.groupTypes[]`);
      if (groupTypes.has(groupType)) {
        fail(`Duplicate group type: ${groupType}`);
      }
      groupTypes.add(groupType);
    }

    if (service.status === 'planned') {
      continue;
    }

    const directory = resolve(root, service.directory);
    if (!existsSync(directory)) {
      fail(`${service.id} directory does not exist: ${service.directory}`);
    }
    if (!existsSync(resolve(directory, 'package.json'))) {
      fail(`${service.id} is missing ${service.directory}/package.json`);
    }

    if (service.role === 'proxy') {
      const modelPath = resolve(directory, 'model.json');
      if (!existsSync(modelPath)) {
        fail(`${service.id} is missing ${service.directory}/model.json`);
      }
      const model = JSON.parse(readFileSync(modelPath, 'utf8'));
      const modelGroups = Object.keys(model.groups ?? {}).sort();
      const declaredGroups = [...service.groupTypes].sort();
      if (JSON.stringify(modelGroups) !== JSON.stringify(declaredGroups)) {
        fail(`${service.id} groupTypes do not match ${service.directory}/model.json`);
      }
      requireString(service.integrationTest, `${service.id}.integrationTest`);
      if (!existsSync(resolve(root, service.integrationTest))) {
        fail(`${service.id} integration test does not exist: ${service.integrationTest}`);
      }
    }

    if (!service.environment || typeof service.environment !== 'object' || Array.isArray(service.environment)) {
      fail(`${service.id}.environment must be an object`);
    }
    for (const [name, value] of Object.entries(service.environment)) {
      requireString(name, `${service.id}.environment key`);
      if (!['string', 'number', 'boolean'].includes(typeof value)) {
        fail(`${service.id}.environment.${name} must be a string, number, or boolean`);
      }
    }

    if (!service.deployment || typeof service.deployment !== 'object' || Array.isArray(service.deployment)) {
      fail(`${service.id}.deployment must be an object`);
    }
    requirePositiveInteger(service.deployment.replicas, `${service.id}.deployment.replicas`);
    requireString(service.deployment.healthPath, `${service.id}.deployment.healthPath`);
    if (!service.deployment.healthPath.startsWith('/')) {
      fail(`${service.id}.deployment.healthPath must start with /`);
    }
    requireString(service.deployment.cpu, `${service.id}.deployment.cpu`);
    requireString(service.deployment.memory, `${service.id}.deployment.memory`);

    if (!Array.isArray(service.images) || service.images.length === 0) {
      fail(`${service.id}.images must be a non-empty array`);
    }
    requireString(service.deployment?.healthPath, `${service.id}.deployment.healthPath`);
    requireString(service.deployment?.readinessPath, `${service.id}.deployment.readinessPath`);
    for (const image of service.images) {
      requireString(image.id, `${service.id}.images[].id`);
      requireString(image.name, `${service.id}.images[].name`);
      requireString(image.dockerfile, `${service.id}.images[].dockerfile`);
      if (imageIds.has(image.id)) {
        fail(`Duplicate image id: ${image.id}`);
      }
      imageIds.add(image.id);
      if (!existsSync(resolve(root, image.dockerfile))) {
        fail(`${service.id} Dockerfile does not exist: ${image.dockerfile}`);
      }
    }
  }

  return manifest;
}

export function selectServices(manifest, filters = {}) {
  return manifest.services.filter(service =>
    (!filters.status || service.status === filters.status) &&
    (!filters.role || service.role === filters.role)
  );
}

export function createMatrix(manifest, matrixName) {
  const active = selectServices(manifest, { status: 'active' });
  switch (matrixName) {
    case 'build':
      return active.map(service => ({
        service: service.id,
        directory: service.directory
      }));
    case 'docker-tests':
      return active
        .filter(service => service.role === 'proxy')
        .map(service => ({
          service: service.id,
          test: service.integrationTest
        }));
    case 'images':
      return active.flatMap(service => service.images.map(image => ({
        service: service.id,
        image: image.id,
        imageName: image.name,
        dockerfile: image.dockerfile
      })));
    default:
      fail(`Unknown matrix: ${matrixName}`);
  }
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      fail(`Unexpected argument: ${arg}`);
    }
    const name = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      fail(`Missing value for ${arg}`);
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

function print(value, format = 'json') {
  if (format === 'lines') {
    for (const item of value) {
      console.log(typeof item === 'string' ? item : item.id);
    }
    return;
  }
  if (format !== 'json') {
    fail(`Unsupported output format: ${format}`);
  }
  console.log(JSON.stringify(value));
}

function runBuild(manifest, serviceId) {
  const services = selectServices(manifest, { status: 'active' })
    .filter(service => !serviceId || service.id === serviceId);
  if (serviceId && services.length === 0) {
    fail(`Unknown active service: ${serviceId}`);
  }

  for (const service of services) {
    console.log(`\n==> Building ${service.id}`);
    const install = spawnSync('npm', ['ci'], {
      cwd: resolve(root, service.directory),
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    if (install.status !== 0) {
      process.exit(install.status ?? 1);
    }
    const build = spawnSync('npm', ['run', 'build'], {
      cwd: resolve(root, service.directory),
      stdio: 'inherit',
      shell: process.platform === 'win32'
    });
    if (build.status !== 0) {
      process.exit(build.status ?? 1);
    }
  }
}

function main() {
  const [command, subject, ...rest] = process.argv.slice(2);
  const manifest = validateManifest();

  if (command === 'validate') {
    console.log(`Validated ${manifest.services.length} services`);
    return;
  }

  if (command === 'list') {
    const options = parseOptions([subject, ...rest].filter(Boolean));
    const services = selectServices(manifest, options);
    print(services, options.format ?? 'json');
    return;
  }

  if (command === 'matrix') {
    if (!subject) {
      fail('matrix requires a matrix name');
    }
    print(createMatrix(manifest, subject));
    return;
  }

  if (command === 'run' && subject === 'build') {
    const options = parseOptions(rest);
    runBuild(manifest, options.service);
    return;
  }

  fail('Usage: service-manifest.mjs validate | list [--status value] [--role value] [--format json|lines] | matrix build|docker-tests|images | run build [--service id]');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
