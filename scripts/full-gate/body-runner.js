'use strict';

const path = require('node:path');
const { MESSAGES, NO_VERDICT } = require('../full-gate');

const [entry, ...args] = process.argv.slice(2);
let finished = false;

function exitAfterScan(code) {
  if (finished) return;
  finished = true;
  process.removeListener('message', acknowledged);
  process.removeListener('disconnect', disconnected);
  process.exitCode = code;
  if (process.connected) process.disconnect();
}

function acknowledged(message) {
  if (message.kind === MESSAGES.BODY_SCAN_COMPLETE) exitAfterScan(resultCode);
}

function disconnected() {
  exitAfterScan(NO_VERDICT);
}

let resultCode = NO_VERDICT;
function complete(code) {
  resultCode = code;
  if (!process.connected || typeof process.send !== 'function') return exitAfterScan(NO_VERDICT);
  process.once('message', acknowledged);
  process.once('disconnect', disconnected);
  process.send({ kind: MESSAGES.BODY_COMPLETE }, error => {
    if (error) exitAfterScan(NO_VERDICT);
  });
}

function fail(error) {
  process.stderr.write('full-gate body: ' + error.message + '\n');
  complete(1);
}

try {
  if (!entry) throw new Error('body entry is required');
  const runBody = require(path.resolve(entry)).runBody;
  if (typeof runBody !== 'function') throw new Error('body entry does not export runBody');
  Promise.resolve(runBody(args)).then(code => {
    complete(Number.isInteger(code) ? code : 0);
  }, fail);
} catch (error) {
  fail(error);
}
