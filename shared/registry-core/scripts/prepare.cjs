const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = join(__dirname, '..');

function runNpm(args) {
  const invocation = process.platform === 'win32'
    ? {
        command: process.env.ComSpec,
        args: ['/d', '/s', '/c', `npm ${args.join(' ')}`]
      }
    : { command: 'npm', args };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (
  !existsSync(join(root, 'node_modules', 'typescript', 'bin', 'tsc')) ||
  !existsSync(join(root, 'node_modules', 'express', 'package.json'))
) {
  runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
}
runNpm(['run', 'build']);
