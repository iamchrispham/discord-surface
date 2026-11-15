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
test('worker proof uses the canonical conductor registry, with or without the Codex alias', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-proof-home-'));
  try {
    const expected = path.join(home, '.agents', 'work-control', 'workers');
    fs.mkdirSync(expected, { recursive: true });
    const env = defaultWorkerEnv(home);
    function resolvedRoot() {
      const result = spawnSync(PYTHON, ['-c',
        'import conductor_worker_proof as proof; print(proof.workers_root())'], {
        env, encoding: 'utf8'
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    }

    assert.equal(resolvedRoot(), fs.realpathSync(expected));

    fs.mkdirSync(path.join(home, '.codex'));
    fs.symlinkSync(path.join(home, '.agents', 'work-control'), path.join(home, '.codex', 'work-control'));
    assert.equal(resolvedRoot(), fs.realpathSync(expected));

    const override = path.join(home, 'other-workers');
    fs.mkdirSync(override);
    env.CONDUCTOR_WORKERS_DIR = override;
    assert.equal(resolvedRoot(), fs.realpathSync(override));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test('worker proof keeps the publisher root when only the Codex alias exists', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-proof-codex-home-'));
  try {
    const legacy = path.join(home, '.codex', 'work-control', 'workers');
    fs.mkdirSync(legacy, { recursive: true });
    const result = spawnSync(PYTHON, ['-c',
      'import conductor_worker_proof as proof; print(proof.workers_root())'], {
      env: {
        ...defaultWorkerEnv(home)
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), path.join(fs.realpathSync(home), '.agents', 'work-control', 'workers'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test('worker proof ignores a distinct Codex alias when canonical death is proven', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-proof-dual-home-'));
  try {
    const canonical = path.join(home, '.agents', 'work-control', 'workers');
    const legacy = path.join(home, '.codex', 'work-control', 'workers');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    const nativeId = 'dual-registry-predecessor-native-id';
    const owner = 'dual-registry-owner';
    const manifest = JSON.stringify({
      sessionId: nativeId, fullUUID: nativeId, worktree: home, state: 'done',
      harness: 'codex', pid: 999999, processStartTime: 1700000000, generation: 1
    });
    fs.writeFileSync(path.join(canonical, `${owner}.json`), manifest);
    fs.writeFileSync(path.join(legacy, `${owner}.json`), JSON.stringify({
      sessionId: nativeId, fullUUID: nativeId, worktree: home, state: 'active',
      harness: 'codex', pid: 1, processStartTime: 1700000000, generation: 1
    }));
    const expected = { fullUUID: nativeId, provider: 'codex', workspace: fs.realpathSync(home) };
    const code = [
      'import json',
      'import conductor_worker_proof as proof',
      'proof.process_probe = lambda pid: ("live", 1700000000) if pid == 1 else ("gone", None)',
      `print(json.dumps(proof.discover_predecessor(${JSON.stringify(expected)}, ${JSON.stringify(owner)})))`
    ].join('; ');
    const result = spawnSync(PYTHON, ['-c', code], {
      env: {
        ...defaultWorkerEnv(home)
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).status, 'gone');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test('worker proof treats an unavailable canonical symlink target as unknown', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-proof-missing-target-home-'));
  try {
    const canonical = path.join(home, '.agents', 'work-control', 'workers');
    const legacy = path.join(home, '.codex', 'work-control', 'workers');
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    fs.symlinkSync(path.join(home, 'registry-mount', 'workers'), canonical, 'dir');
    fs.mkdirSync(legacy, { recursive: true });
    const nativeId = 'missing-target-predecessor-native-id';
    const owner = 'missing-target-owner';
    fs.writeFileSync(path.join(legacy, `${owner}.json`), JSON.stringify({
      sessionId: nativeId, fullUUID: nativeId, worktree: home,
      harness: 'codex', pid: 999999, processStartTime: 1700000000, generation: 1
    }));
    const expected = { fullUUID: nativeId, provider: 'codex', workspace: fs.realpathSync(home) };
    const code = [
      'import json',
      'import conductor_worker_proof as proof',
      "proof.process_probe = lambda pid: ('gone', None)",
      `print(json.dumps(proof.discover_predecessor(${JSON.stringify(expected)}, ${JSON.stringify(owner)})))`
    ].join('; ');
    const result = spawnSync(PYTHON, ['-c', code], {
      env: {
        ...defaultWorkerEnv(home)
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).status, 'unknown');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test('worker proof requires an explicit override for a separate Codex registry', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-proof-legacy-home-'));
  try {
    const legacy = path.join(home, '.codex', 'work-control', 'workers');
    fs.mkdirSync(legacy, { recursive: true });
    const nativeId = 'legacy-predecessor-native-id';
    const owner = 'legacy-owner';
    const expected = { fullUUID: nativeId, provider: 'codex', workspace: fs.realpathSync(home) };
    fs.writeFileSync(path.join(legacy, `${owner}.json`), JSON.stringify({
      sessionId: nativeId, fullUUID: nativeId, worktree: home, state: 'done',
      harness: 'codex', pid: 999999, processStartTime: 1700000000, generation: 1
    }));
    const code = [
      'import json',
      'import conductor_worker_proof as proof',
      "proof.process_probe = lambda pid: ('gone', None)",
      `print(json.dumps(proof.discover_predecessor(${JSON.stringify(expected)}, ${JSON.stringify(owner)})))`
    ].join('; ');
    const result = spawnSync(PYTHON, ['-c', code], {
      env: {
        ...defaultWorkerEnv(home)
      },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim()).status, 'missing');

    const migrated = spawnSync(PYTHON, ['-c', code], {
      env: {
        ...defaultWorkerEnv(home),
        CONDUCTOR_WORKERS_DIR: legacy
      },
      encoding: 'utf8'
    });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.equal(JSON.parse(migrated.stdout.trim()).status, 'gone');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
test('worker proof treats unavailable canonical ancestor symlinks as unknown', () => {
  for (const ancestor of ['agents', 'work-control']) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `worker-proof-missing-${ancestor}-home-`));
    try {
      const legacy = path.join(home, '.codex', 'work-control', 'workers');
      const missing = path.join(home, 'registry-mount', 'work-control');
      if (ancestor === 'agents') {
        fs.mkdirSync(path.dirname(missing), { recursive: true });
        fs.symlinkSync(path.dirname(missing), path.join(home, '.agents'), 'dir');
      } else {
        fs.mkdirSync(path.join(home, '.agents'), { recursive: true });
        fs.symlinkSync(missing, path.join(home, '.agents', 'work-control'), 'dir');
      }
      fs.mkdirSync(legacy, { recursive: true });
      const nativeId = `missing-${ancestor}-predecessor-native-id`;
      const owner = `missing-${ancestor}-owner`;
      fs.writeFileSync(path.join(legacy, `${owner}.json`), JSON.stringify({
        sessionId: nativeId, fullUUID: nativeId, worktree: home,
        harness: 'codex', pid: 999999, processStartTime: 1700000000, generation: 1
      }));
      const expected = { fullUUID: nativeId, provider: 'codex', workspace: fs.realpathSync(home) };
      const code = [
        'import json',
        'import conductor_worker_proof as proof',
        `print(json.dumps(proof.discover_predecessor(${JSON.stringify(expected)}, ${JSON.stringify(owner)})))`
      ].join('; ');
      const result = spawnSync(PYTHON, ['-c', code], {
        env: {
          ...defaultWorkerEnv(home)
        },
        encoding: 'utf8'
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout.trim()).status, 'unknown', ancestor);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('isolated successor wrapper leaves a fresh source copy free of bytecode', () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const helper = path.join(__dirname, 'helpers', 'successor-authority.py');
  const probe = String.raw`import importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile
helper_path = pathlib.Path(sys.argv[1]).resolve()
spec = importlib.util.spec_from_file_location('successor_authority_fixture', helper_path)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
root = helper_path.parents[2]
with tempfile.TemporaryDirectory(prefix='successor-wrapper-bytecode-') as temporary:
    temporary = pathlib.Path(temporary)
    source = temporary / 'source-copy'
    shutil.copytree(root / 'src', source, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    wrapper = temporary / 'gate-wrapper.py'
    wrapper.write_text(fixture.WRAPPER, encoding='utf-8')
    gate = temporary / 'gate.py'
    gate.write_text(chr(10).join([
        'import os',
        'from pathlib import Path',
        "Path(os.environ['FIXTURE_WRAPPER_MARKER']).write_text('ran', encoding='utf-8')",
    ]) + chr(10), encoding='utf-8')
    mocks = temporary / 'mocks.json'
    mocks.write_text(json.dumps({'argv': [str(gate)], 'gate': str(gate)}), encoding='utf-8')
    environment = dict(os.environ)
    environment.update({
        'DISCORD_SURFACE_FIXTURE_SRC': str(source),
        'DISCORD_SURFACE_FIXTURE_MOCKS': str(mocks),
        'FIXTURE_WRAPPER_MARKER': str(temporary / 'wrapper-ran'),
        'PYTHONDONTWRITEBYTECODE': '1',
    })
    result = subprocess.run([sys.executable, '-I', str(wrapper)], env=environment,
        capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert pathlib.Path(environment['FIXTURE_WRAPPER_MARKER']).read_text(encoding='utf-8') == 'ran'
    caches = list(source.rglob('__pycache__'))
    assert not caches, caches
    print(json.dumps({'wrapper': 'completed', 'sourceBytecodeDirectories': len(caches)}))`;
  const result = spawnSync(process.env.DISCORD_SURFACE_PYTHON || 'python3', ['-I', '-B', '-c', probe, helper], {
    encoding: 'utf8', timeout: 15000
  });
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.wrapper, 'completed');
  assert.equal(report.sourceBytecodeDirectories, 0);
});
