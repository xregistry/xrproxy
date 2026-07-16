import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function serviceBlock(text, serviceId) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line === `  ${serviceId}:`);
  if (start < 0) {
    throw new Error(`missing Compose service ${serviceId}`);
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [a-z0-9][a-z0-9-]*:$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

export function validateComposeText(text, services, filename) {
  const active = services.filter(service => service.status === 'active');
  const bridge = serviceBlock(text, 'bridge');

  for (const service of active) {
    const port = service.port;
    const block = serviceBlock(text, service.id);
    if (!block.includes(`- "${port}:${port}"`)) {
      throw new Error(`${filename}: ${service.id} must publish canonical port ${port}`);
    }
    if (!new RegExp(`- [A-Z0-9_]*PORT=${port}(?:\\n|$)`).test(block)) {
      throw new Error(`${filename}: ${service.id} must configure canonical port ${port}`);
    }
    if (!block.includes(`http://localhost:${port}/`)) {
      throw new Error(`${filename}: ${service.id} health check must use canonical port ${port}`);
    }
    if (service.role === 'proxy' && !bridge.includes(`"url":"http://${service.id}:${port}"`)) {
      throw new Error(`${filename}: bridge downstream for ${service.id} must use port ${port}`);
    }
  }
}

export function validateComposeFiles() {
  const manifest = JSON.parse(readFileSync(new URL('../config/services.json', import.meta.url), 'utf8'));
  for (const filename of ['docker-compose.yml', 'docker-compose-gh.yml']) {
    const text = readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8');
    validateComposeText(text, manifest.services, filename);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  validateComposeFiles();
  console.log('Compose service ports match config/services.json');
}
