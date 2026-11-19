'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { pythonTestEnvironment } = require('../scripts/test-gate');

const root = path.resolve(__dirname, '..');
for (const scenario of [
  'reason-order', 'required-hold', 'replacement-failure', 'blocked-delivery', 'phase-reserve',
  'large-publish-memory', 'large-required-files', 'expired-range-delivery', 'marker-delivery-error',
  'scratch-retirement-deadline',
  'finalizer-receipt', 'finalizer-handler', 'finalizer-creation', 'finalizer-clock',
  'linux-0', 'linux-17', 'linux-98', 'linux-marked', 'linux-multiple-markers', 'linux-journal-short-write',
  'linux-adopted-child-drain', 'linux-final-relay-reserve', 'linux-incomplete-marker', 'linux-post-exit-cancel',
  'linux-permanent-relay-failure', 'linux-verifier-cleanup', 'linux-setup-verifier-cleanup',
  'darwin-bootstrap', 'darwin-exception', 'darwin-large'
]) {
  test('terminal output owner: ' + scenario, {
    timeout: 30000,
    skip: ['large-publish-memory', 'linux-post-exit-cancel'].includes(scenario) && process.platform !== 'linux'
  }, () => {
    const result = spawnSync(process.env.DISCORD_SURFACE_PYTHON || 'python3', [
      '-I', '-B', path.join(__dirname, 'helpers/full-gate-terminal.py'),
      path.join(root, 'scripts/full-gate/supervisor.py'), scenario
    ], {
      cwd: root, env: pythonTestEnvironment({ PATH: process.env.PATH }),
      encoding: 'utf8', timeout: 25000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
