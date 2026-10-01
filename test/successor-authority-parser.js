'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { SurfaceState, READINESS, THREAD_STATES } = require('../src/state');
const { DiscordGateway } = require('../src/discord');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { conductorMarker } = require('../src/cli');
const { CODEX_ID, SUCCESSOR_ID, CONDUCTOR_LOCK, CLI_PATH, fixture, historyPermissions, conductorLock, processStartTime, lockArtifacts, waitForProcessGone } = require('./surface-fixtures');
const PYTHON = process.env.DISCORD_SURFACE_PYTHON || 'python3';
const HELPER = path.join(__dirname, 'helpers', 'successor-authority.py');
const { runScenario, defaultWorkerEnv, assertRefused, assertCommitted, runPythonGate, fakeDiscordPreload, runPublicPickup, buildStealFixture, fakeDiscordClient, lockEnvFor } = require('./successor-authority-fixture');
test('deep transcript header refuses through the gate error boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-transcript-'));
  try {
    const transcript = path.join(root, `rollout-test-${CODEX_ID}.jsonl`);
    fs.writeFileSync(transcript, `${'['.repeat(1500)}0${']'.repeat(1500)}\n`, { mode: 0o600 });
    const result = runPythonGate(
      "proof.verify_transcript(sys.argv[1], 'codex', sys.argv[2])",
      [transcript, CODEX_ID], { CONDUCTOR_CODEX_SESSIONS_DIR: root }
    );
    assert.equal(result.status, 2, result.stderr);
    // Newer Python may parse this depth and reject the header by shape instead.
    assert.match(result.stderr, /REFUSED: (session transcript header is invalid|Codex session transcript header is not a session_meta event)/);
    assert.doesNotMatch(result.stderr, /Traceback/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('deep lock command JSON refuses through the gate error boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-lock-readback-'));
  try {
    const lockScript = path.join(root, 'lock.sh');
    fs.writeFileSync(lockScript, `#!/bin/sh\nprintf '%s\\n' '${'['.repeat(1500)}0${']'.repeat(1500)}'\n`, { mode: 0o700 });
    const result = runPythonGate(
      "__import__('runpy').run_path(sys.argv[1])['run_lock'](sys.argv[2], 'example/repo', 'codex', 'inspect')",
      [path.resolve(__dirname, '../src/conductor-lock-gate.py'), lockScript]
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /REFUSED: conductor lock inspect returned (invalid|a non-object) readback/);
    assert.doesNotMatch(result.stderr, /Traceback/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
