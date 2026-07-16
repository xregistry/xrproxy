const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const directory = join(__dirname, '..', 'dist', 'test');
const tests = readdirSync(directory)
  .filter(file => file.endsWith('.test.js'))
  .sort()
  .map(file => join(directory, file));
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
process.exit(result.status ?? 1);
