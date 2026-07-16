const { existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const packageRoot = join(__dirname, '..');
const consumer = join(packageRoot, '.file-consumer-test');
const dist = join(packageRoot, 'dist');
const dependencies = join(packageRoot, 'node_modules');

rmSync(consumer, { recursive: true, force: true });
rmSync(dist, { recursive: true, force: true });
rmSync(dependencies, { recursive: true, force: true });
mkdirSync(consumer, { recursive: true });
writeFileSync(join(consumer, 'package.json'), JSON.stringify({
  name: 'registry-core-file-consumer',
  private: true,
  dependencies: {
    '@xregistry/registry-core': 'file:..'
  }
}, null, 2));

try {
  const installCommand = process.platform === 'win32'
    ? { command: process.env.ComSpec, args: ['/d', '/s', '/c', 'npm install --no-audit --no-fund'] }
    : { command: 'npm', args: ['install', '--no-audit', '--no-fund'] };
  const install = spawnSync(installCommand.command, installCommand.args, {
    cwd: consumer,
    stdio: 'inherit'
  });
  if (install.error) {
    throw install.error;
  }
  if (install.status !== 0) {
    throw new Error(`npm install exited with status ${install.status ?? 1}`);
  }
  if (!existsSync(dist)) {
    throw new Error('file: install did not run the registry-core prepare build');
  }
  const smoke = spawnSync(process.execPath, ['-e',
    "const core=require('@xregistry/registry-core'); if(typeof core.HttpUpstreamClient!=='function') process.exit(1)"
  ], {
    cwd: consumer,
    stdio: 'inherit'
  });
  if (smoke.error) {
    throw smoke.error;
  }
  if (smoke.status !== 0) {
    throw new Error(`file dependency smoke test exited with status ${smoke.status ?? 1}`);
  }
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
