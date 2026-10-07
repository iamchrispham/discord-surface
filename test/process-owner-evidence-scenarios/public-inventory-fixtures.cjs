'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { inventoryProcessOwnerSites, SRC_ROOT } = require('./source-inventory.cjs');

const withFiles = (files, visit) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-probe-modules-'));
  try {
    for (const [fileName, source] of Object.entries(files)) {
      const fullPath = path.join(directory, fileName);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, source);
    }
    return visit(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const inventoryFiles = files => withFiles(files, inventoryProcessOwnerSites);

const runFilesFixture = (files, expectedKills, expectedViolations, expectedLegacyCalls = []) => {
  withFiles(files, directory => {
    const result = inventoryProcessOwnerSites(directory);
    assert.deepEqual(result.kills, expectedKills);
    assert.deepEqual(result.legacyCalls, expectedLegacyCalls);
    assert.deepEqual(result.violations, expectedViolations);
  });
};

const runFixture = (source, expectedKills, expectedViolations, fileName = 'private-alias.js',
  expectedLegacyCalls = []) => runFilesFixture({ [fileName]: source }, expectedKills,
  expectedViolations, expectedLegacyCalls);

module.exports = { inventoryFiles, runFixture, runFilesFixture, inventoryProcessOwnerSites, SRC_ROOT };
