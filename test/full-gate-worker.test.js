'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const gate = require('../scripts/full-gate');

const workerPath = path.resolve(__dirname, '../scripts/full-gate-worker.js');
const workerSource = fs.readFileSync(workerPath, 'utf8');

function fixture() {
  const admission = new EventEmitter();
  const body = new EventEmitter();
  const worker = new EventEmitter();
  const messages = [];
  const exits = [];
  const signals = [];
  Object.assign(worker, {
    argv: ['node', workerPath, '0', 'entry.js'],
    connected: true,
    env: {},
    pid: 101,
    send: message => messages.push(message),
    exit: code => exits.push(code),
    kill: (_pid, signal) => signals.push(signal)
  });
  vm.runInNewContext(workerSource, {
    __dirname: path.dirname(workerPath),
    process: worker,
    setTimeout: () => {},
    require: name => {
      if (name === 'node:child_process') return { spawn: () => admission, fork: () => body };
      if (name === './full-gate') return { ...gate, noVerdict: () => gate.NO_VERDICT };
      return require(name);
    }
  }, { timeout: 1000 });
  worker.emit('message', { kind: gate.MESSAGES.ADMIT, command: 'admit', args: [] });
  return { admission, body, worker, messages, exits, signals };
}

test('admission spawn failure waits for closure and allows clean worker shutdown', () => {
  const f = fixture();
  f.admission.emit('error', new Error('admission executable unavailable'));
  assert.equal(f.messages.some(message => message.kind === gate.MESSAGES.ADMISSION_EXIT), false);
  f.admission.emit('close', -2);
  const outcome = f.messages.filter(message => message.kind === gate.MESSAGES.ADMISSION_EXIT);
  assert.equal(outcome.length, 1);
  assert.match(outcome[0].error, /admission executable unavailable/);
  f.worker.emit('message', { kind: gate.MESSAGES.CLOSE });
  assert.deepEqual(f.exits, [0]);
  assert.deepEqual(f.signals, []);
});

test('body spawn failure stays distinct from a genuine exit 1', () => {
  for (const launched of [false, true]) {
    const f = fixture();
    f.admission.emit('close', 0);
    f.worker.emit('message', { kind: gate.MESSAGES.START });
    if (launched) f.body.pid = 102;
    else {
      f.body.emit('error', new Error('body interpreter unavailable'));
      assert.equal(f.messages.some(message => message.kind === gate.MESSAGES.BODY_EXIT), false);
    }
    f.body.emit('close', launched ? 1 : -2, null);
    const outcome = f.messages.filter(message => message.kind === gate.MESSAGES.BODY_EXIT);
    assert.equal(outcome.length, 1);
    if (launched) assert.equal(outcome[0].code, 1);
    else {
      assert.match(outcome[0].error, /body interpreter unavailable/);
      assert.equal(outcome[0].code, undefined);
    }
    f.worker.emit('message', { kind: gate.MESSAGES.CLOSE });
    assert.deepEqual(f.exits, [0]);
    assert.deepEqual(f.signals, []);
  }
});

test('a post-launch child error stops the worker before declaring body completion', () => {
  const f = fixture();
  f.admission.emit('close', 0);
  f.worker.emit('message', { kind: gate.MESSAGES.START });
  f.body.pid = 102;
  f.body.emit('error', new Error('IPC failure'));
  assert.equal(f.messages.some(message => message.kind === gate.MESSAGES.BODY_EXIT), false);
  assert.deepEqual(f.signals, ['SIGTERM']);
  f.body.emit('close', null, 'SIGTERM');
  assert.equal(f.messages.find(message => message.kind === gate.MESSAGES.BODY_EXIT).code, 143);
});
