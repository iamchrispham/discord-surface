'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { runFullGate, nodeOptionTokens } = require('./full-gate');

const root = path.resolve(__dirname, '..');
const suites = process.argv.slice(2);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function validSelection() {
  const registered = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts.test.split(/\s+/).slice(2);
  const selectionOption = /^--test(?:-name-pattern|-skip-pattern|-only|-shard)(?:=|$)/;
  const explicitFiles = suites.every(file => /^test\/.+\.(?:js|cjs)$/.test(file));
  const completeList = suites.length > 0 && explicitFiles && new Set(suites).size === suites.length && JSON.stringify(suites) === JSON.stringify(registered);
  const selectionRequested = nodeOptionTokens(process.env.NODE_OPTIONS || '').some(token => selectionOption.test(token.replace(/_/g, '-')));
  return completeList && !selectionRequested;
}

async function body() {
  const commands = [
    [npm, ['run', 'build']],
    [npm, ['run', 'typecheck']],
    [process.execPath, ['--test', '--test-concurrency=1', ...suites]]
  ];
  for (const [command, args] of commands) {
    if (command === process.execPath) process.stdout.write('FULL_GATE_TEST_ARGUMENTS=' + JSON.stringify(suites) + '\n');
    const env = { ...process.env };
    if (command === process.execPath) delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env });
    if (result.error) throw result.error;
    if (result.signal) return 128 + os.constants.signals[result.signal];
    if (result.status !== 0) return result.status;
  }
  return 0;
}

if (!validSelection()) {
  process.stderr.write('test gate requires the complete registered suite list without selection options\n');
  process.exitCode = 4;
} else {
  runFullGate(root, 'test', __filename, suites, body)
    .then(code => { process.exitCode = code; })
    .catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
