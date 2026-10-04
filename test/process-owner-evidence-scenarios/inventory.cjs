'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { inventoryProcessOwnerSites, SRC_ROOT } = require('./source-inventory.cjs');

test('structural inventory accounts for every PID probe and leaves no legacy destructive callsite', () => {
  const inventory = inventoryProcessOwnerSites(SRC_ROOT);
  assert.deepEqual(inventory.violations, [], `owner-evidence inventory violations:\n${inventory.violations.join('\n')}`);
  const expected = [
    'claude/socket-ownership/lock-owner.ts\u0000isSocketLockOwnerAlive',
    'cli/gateway-process.js\u0000gatewayProcessStatus',
    'cli/gateway-process.js\u0000waitForExit',
    'cli/runtime-lifecycle.js\u0000stop',
    'cli/runtime-custody.js\u0000acquireHeldLock',
    'state.js\u0000probePid',
    'state.js\u0000probePid',
    'state/intake.js\u0000processAlive'
  ].sort();
  assert.deepEqual([...inventory.kills].sort(), expected, 'every process.kill(pid,0) site must be explicitly inventoried');
  assert.deepEqual(inventory.legacyCalls, [], 'no production callsite may use the legacy boolean destructive path');
});

// ---------------------------------------------------------------------------
// Test 12: inventory red controls
// ---------------------------------------------------------------------------

test('inventory goes red for a new private PID probe and a legacy-false destructive copy', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-evidence-inventory-'));
  try {
    const emptyRoot = path.join(tmpRoot, 'clean');
    fs.mkdirSync(path.join(emptyRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(emptyRoot, 'src', 'index.js'), "'use strict';\nmodule.exports = {};\n");
    assert.deepEqual(inventoryProcessOwnerSites(emptyRoot).violations, [], 'clean source must not false-positive');

    const probeRoot = path.join(tmpRoot, 'private-probe');
    fs.mkdirSync(path.join(probeRoot, 'src', 'state'), { recursive: true });
    fs.writeFileSync(path.join(probeRoot, 'src', 'state', 'new-probe.js'), [
      "'use strict';",
      'function privateOwnerProbe(pid) {',
      '  try { process.kill(pid, 0); } catch { return false; }',
      '  return true;',
      '}',
      'module.exports = { privateOwnerProbe };'
    ].join('\n'));
    assert.throws(
      () => {
        const found = inventoryProcessOwnerSites(probeRoot);
        if (found.violations.length > 0) throw new Error(found.violations.join('\n'));
        throw new Error('inventory unexpectedly accepted a new private PID probe');
      },
      /unclassified process probe src\/state\/new-probe.js:privateOwnerProbe/
    );

    const siblings = [
      "function newProbe(pid) { process['kill'](pid, 0); }",
      'const signal = 0; function newProbe(pid) { process.kill(pid, signal); }',
      'const probe = process.kill; function newProbe(pid) { probe(pid, 0); }',
      'const proc = process; function newProbe(pid) { proc.kill(pid, 0); }',
      'const {kill} = process; function newProbe(pid) { kill(pid, 0); }',
      "function newCleanup(state,pid,identity) { return state['directPostOwnerAlive'](pid,identity); }"
    ];
    for (const [index, code] of siblings.entries()) {
      const siblingRoot = path.join(tmpRoot, `sibling-${index}`);
      fs.mkdirSync(siblingRoot);
      fs.writeFileSync(path.join(siblingRoot, 'new-owner.js'), code);
      assert.equal(inventoryProcessOwnerSites(siblingRoot).violations.length, 1, code);
    }

    const legacyRoot = path.join(tmpRoot, 'legacy-cleanup');
    fs.mkdirSync(path.join(legacyRoot, 'src', 'state'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'src', 'state', 'legacy-cleanup.js'), [
      "'use strict';",
      "const fs = require('node:fs');",
      'function legacyFalseCleanup(state, pid, identity, stagedPath) {',
      '  const alive = state.directPostOwnerAlive(pid, identity);',
      '  if (!alive) fs.unlinkSync(stagedPath);',
      '}',
      'module.exports = { legacyFalseCleanup };'
    ].join('\n'));
    assert.throws(
      () => {
        const found = inventoryProcessOwnerSites(legacyRoot);
        if (found.violations.length > 0) throw new Error(found.violations.join('\n'));
        throw new Error('inventory unexpectedly accepted a legacy boolean destructive copy');
      },
      /legacy directPostOwnerAlive callsite src\/state\/legacy-cleanup.js:legacyFalseCleanup/
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
