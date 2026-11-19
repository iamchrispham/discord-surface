'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { createWatchdogCollector, COLLECTOR_FAILURE_ORIGINS } = require('../scripts/full-gate/watchdog-collector');

test('cancel closes scan pipes held by a helper after the scanner exits', { timeout: 15000 }, async t => {
  const holdPipes = `
    process.stdout.on('error', () => process.exit(0));
    process.stdout.write('holding');
    setInterval(() => process.stdout.write('holding'), 100);
    setTimeout(() => process.exit(0), 5000);
  `;
  const launchScan = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(holdPipes)}], { stdio: ['ignore', 1, 2] }).unref();
    setTimeout(() => process.exit(1), 5000).unref();
  `;
  let child;
  const collector = createWatchdogCollector({ spawn: (...args) => (child = spawn(...args)) });
  const phase = collector.begin(Date.now() + 10000);
  const result = collector.run(phase, process.execPath, ['-e', launchScan], process.env);
  t.after(async () => {
    collector.cancel();
    await collector.whenClosed();
  });

  const [[exitCode]] = await Promise.all([once(child, 'exit'), once(child.stdout, 'data')]);
  assert.equal(exitCode, 0);
  assert.equal(child.stdout.destroyed, false);
  assert.equal(child.stderr.destroyed, false);

  collector.cancel();
  assert.equal(child.stdout.destroyed, true, 'cancel must close the inherited stdout reader');
  assert.equal(child.stderr.destroyed, true, 'cancel must close the inherited stderr reader');
  assert.equal((await result).failureOrigin, COLLECTOR_FAILURE_ORIGINS.CANCEL_REQUEST);
  await collector.whenClosed();
  assert.equal(collector.owned(), false);
});
