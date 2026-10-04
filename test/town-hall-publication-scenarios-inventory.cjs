'use strict';

const { analyzePublicationOwnership, listProductionSourceFiles, parseProductionSources, publicationSourceRoot } = require('./town-hall-publication-scenarios-source-inventory.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

test('publication receipts have one writer and decoder', { timeout: 30000 }, () => {
  const root = publicationSourceRoot();
  const files = listProductionSourceFiles(root);
  assert.ok(files.length > 0, `no production source files found under ${path.join(root, 'src')}`);
  const records = parseProductionSources(root, files);
  const failures = analyzePublicationOwnership(records);
  assert.deepEqual(failures, [], `source ownership census failed (${root}):\n${failures.join('\n')}`);
});
