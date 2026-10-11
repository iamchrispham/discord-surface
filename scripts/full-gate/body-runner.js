'use strict';

const path = require('node:path');

const [entry, ...args] = process.argv.slice(2);

function fail(error) {
  process.stderr.write('full-gate body: ' + error.message + '\n');
  process.exitCode = 1;
}

try {
  if (!entry) throw new Error('body entry is required');
  const runBody = require(path.resolve(entry)).runBody;
  if (typeof runBody !== 'function') throw new Error('body entry does not export runBody');
  Promise.resolve(runBody(args)).then(code => {
    process.exitCode = Number.isInteger(code) ? code : 0;
  }, fail);
} catch (error) {
  fail(error);
}
