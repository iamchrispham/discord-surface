#!/usr/bin/env python3
"""Disposable fixtures for the canonical successor-authority suite.

Test-only. Never imported by production code: test/successor-authority.test.js
invokes this file as a bounded subprocess with a JSON scenario on stdin and
reads a JSON result on stdout. Every root, manifest, lock file and child is
disposable, and every spawned child self-expires in under ten seconds.

Usage:
  python3 test/helpers/successor-authority.py run <scenario> <config-json>
  python3 test/helpers/successor-authority.py list
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(ROOT, 'src')
NODE_PATH = os.environ.get('DISCORD_SURFACE_FIXTURE_NODE') or shutil.which('node') or 'node'
GATE_PATH = os.path.join(SRC, 'conductor-lock-gate.py')
CARRY_ENV = 'DISCORD_SURFACE_HANDOFF_CARRY_ACCEPTED_HUMAN'
MARKER_ENV = 'DISCORD_SURFACE_FIXTURE_COMMIT_MARKER'
WRAPPER_ENV = 'DISCORD_SURFACE_FIXTURE_MOCKS'
WRAPPER_SRC_ENV = 'DISCORD_SURFACE_FIXTURE_SRC'
CHILD_SECONDS = 8


def write_text(path, text, mode=0o600):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as handle:
        handle.write(text)
    os.chmod(path, mode)
    return path


def write_json(path, value, mode=0o600):
    return write_text(path, json.dumps(value), mode)


def process_start_time(pid):
    """Real lstart epoch for a live process, matching the gate's parser."""
    probe = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='],
                           check=False, capture_output=True, text=True, timeout=5)
    if probe.returncode != 0 or not probe.stdout.strip():
        return None
    value = ' '.join(probe.stdout.split())
    return int(datetime.datetime.strptime(value, '%a %b %d %H:%M:%S %Y').timestamp())


def spawn_bounded_child(seconds=CHILD_SECONDS):
    """A self-expiring process whose pid/start can back a live manifest."""
    code = 'import time,sys; time.sleep(float(sys.argv[1]))'
    return subprocess.Popen([sys.executable, '-c', code, str(seconds)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def spawn_live(seconds=CHILD_SECONDS):
    child = spawn_bounded_child(seconds)
    deadline = time.time() + 3
    while time.time() < deadline:
        started = process_start_time(child.pid)
        if started is not None:
            return child, child.pid, started
        time.sleep(0.02)
    stop_child(child)
    raise RuntimeError('could not observe live child process start time')


def spawn_dead():
    child = spawn_bounded_child(0.1)
    pid = child.pid
    child.wait(timeout=5)
    return pid


def stop_child(process):
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


def successor_manifest(native_id, owner, workspace, pid, started, generation=1, harness='codex'):
    return {
        'laneId': f'{owner}-9eaba20295e60eb88306d751eb0aeae1',
        'worktree': workspace,
        'state': 'active',
        'harness': harness,
        'sessionId': native_id,
        'fullUUID': native_id,
        'pid': pid,
        'processStartTime': started,
        'generation': generation,
    }


def predecessor_manifest(native_id, workspace, pid, started, state='done', harness='codex'):
    return {
        'sessionId': native_id,
        'fullUUID': native_id,
        'worktree': workspace,
        'state': state,
        'harness': harness,
        'pid': pid,
        'processStartTime': started,
        'generation': 1,
    }


def write_transcript(root, native_id):
    sessions = os.path.join(root, 'sessions')
    os.makedirs(sessions, mode=0o700, exist_ok=True)
    path = os.path.join(sessions, f'rollout-fixture-{native_id}.jsonl')
    body = json.dumps({'type': 'session_meta', 'payload': {'id': native_id}}) + '\n'
    return write_text(path, body)


LOCK_STUB = r'''#!/usr/bin/env python3
"""Disposable identity/inspect readback stub for the lock gate."""
import json
import os
import sys

with open(os.environ['DISCORD_SURFACE_FIXTURE_LOCK_SPEC'], 'r', encoding='utf-8') as handle:
    spec = json.load(handle)
verb = sys.argv[5] if len(sys.argv) > 5 else ''
if verb == 'identity':
    print(json.dumps(spec['identity']))
    raise SystemExit(0)
if verb == 'inspect':
    print(json.dumps(spec['inspect']))
    raise SystemExit(0)
raise SystemExit(1)
'''

WRAPPER = r'''#!/usr/bin/env python3
"""Bounded gate runner that installs deterministic proof mocks first."""
import json
import os
import runpy
import sys
import tempfile

sys.path.insert(0, os.environ['DISCORD_SURFACE_FIXTURE_SRC'])
import conductor_worker_proof as proof  # noqa: E402

spec = json.load(open(os.environ['DISCORD_SURFACE_FIXTURE_MOCKS'], 'r', encoding='utf-8'))
counts = {'predecessor': 0, 'predecessor_replace': 0, 'successor': 0}


def _unknown(*_args, **_kwargs):
    return 'unknown', None


if spec.get('eperm'):
    proof.process_probe = _unknown
if spec.get('unknownStartPid'):
    _real_start = proof.process_start_time
    _target = spec['unknownStartPid']

    def _perhaps_none(pid):
        return None if pid == _target else _real_start(pid)

    proof.process_start_time = _perhaps_none

# Descriptor-window identity proof: replace the predecessor manifest pathname
# with identical bytes immediately after the real manifest read returns, so the
# bytes and the pathname identity provably come from different inodes. The gate
# reads the predecessor manifest four times (pre-lock validation, first snapshot
# capture, locked validation, second snapshot capture); this fires once, right
# after read number `after`, and never mutates again.
if spec.get('replaceAfterRead'):
    _real_read_json = proof.read_json
    _read_counts = {'predecessor': 0}

    def _read_json_replacing(path, label, *args, **kwargs):
        result = _real_read_json(path, label, *args, **kwargs)
        mutation = spec['replaceAfterRead']
        if os.path.basename(path) == os.path.basename(mutation['path']):
            _read_counts['predecessor'] += 1
            if _read_counts['predecessor'] == mutation['after']:
                target = mutation['path']
                with open(target, 'rb') as handle:
                    body = handle.read()
                descriptor, replacement = tempfile.mkstemp(
                    dir=os.path.dirname(target), prefix='.swap-', suffix='.json')
                with os.fdopen(descriptor, 'wb') as handle:
                    handle.write(body)
                os.chmod(replacement, 0o600)
                os.replace(replacement, target)
        return result

    proof.read_json = _read_json_replacing


def _patch_after(original, mutation, key):
    def wrapped(*args, **kwargs):
        result = original(*args, **kwargs)
        counts[key] += 1
        if counts[key] == mutation['after']:
            with open(mutation['path'], 'r', encoding='utf-8') as handle:
                body = json.load(handle)
            body.update(mutation['set'])
            with open(mutation['path'], 'w', encoding='utf-8') as handle:
                json.dump(body, handle)
            os.chmod(mutation['path'], 0o600)
        return result
    return wrapped


def _patch_after_replace(original, mutation, key):
    def wrapped(*args, **kwargs):
        result = original(*args, **kwargs)
        counts[key] += 1
        if counts[key] == mutation['after']:
            path = mutation['path']
            with open(path, 'rb') as handle:
                body = handle.read()
            descriptor, replacement = tempfile.mkstemp(
                dir=os.path.dirname(path), prefix='.replace-', suffix='.json')
            with os.fdopen(descriptor, 'wb') as handle:
                handle.write(body)
            os.chmod(replacement, 0o600)
            os.replace(replacement, path)
        return result
    return wrapped


if spec.get('mutationPredecessor'):
    proof.discover_predecessor = _patch_after(
        proof.discover_predecessor, spec['mutationPredecessor'], 'predecessor')
if spec.get('mutationPredecessorReplace'):
    proof.discover_predecessor = _patch_after_replace(
        proof.discover_predecessor, spec['mutationPredecessorReplace'], 'predecessor_replace')
if spec.get('mutationSuccessor'):
    proof.successor_snapshot = _patch_after(
        proof.successor_snapshot, spec['mutationSuccessor'], 'successor')

sys.argv = spec['argv']
runpy.run_path(spec['gate'], run_name='__main__')
'''

MARKER_CHILD = r'''const fs = require('node:fs');
const marker = process.env.DISCORD_SURFACE_FIXTURE_COMMIT_MARKER;
if (marker) {
  fs.writeFileSync(marker, JSON.stringify({
    carry: process.env.DISCORD_SURFACE_HANDOFF_CARRY_ACCEPTED_HUMAN ?? null,
    gateHeld: process.env.DISCORD_SURFACE_HANDOFF_GATE_HELD ?? null,
    argv: process.argv.slice(2)
  }));
}
process.exit(0);
'''


def _row(at, verb, who, note='fixture'):
    return {'at': at, 'verb': verb, 'who': who, 'note': note}


def build_history(cfg):
    if cfg.get('history'):
        return cfg['history']
    old, succ = cfg['oldOwner'], cfg['succOwner']
    kind = cfg.get('historyKind', 'steal')
    base = [_row('2026-09-28 00:00', 'release', old, 'release predecessor'),
            _row('2026-09-28 00:01', 'claim', old, 'claim predecessor')]
    tails = {
        'steal': [_row('2026-09-28 00:02', 'steal', succ, 'death proof')],
        'normal': [_row('2026-09-28 00:02', 'claim', succ, 'claim successor')],
        'override': [_row('2026-09-28 00:02', 'override', succ, 'override')],
        'preempt': [_row('2026-09-28 00:02', 'preempt', succ, 'preempt')],
    }
    if kind not in tails:
        raise ValueError(f'unknown historyKind {kind!r}')
    if kind == 'normal':
        return [_row('2026-09-28 00:00', 'release', old, 'release predecessor'),
                _row('2026-09-28 00:02', 'claim', succ, 'claim successor')]
    return base + tails[kind]


def _invalid_identity_body(cfg, workspace, live, dead):
    """A manifest that claims the exact bound identity but with one malformed field."""
    uuid = cfg.get('predecessorUuid', cfg['oldNativeId'])
    if cfg.get('invalidDead'):
        pid, started = dead, 1700000000
    else:
        pid, started = live
    body = predecessor_manifest(uuid, workspace, pid, started, state='done')
    field = cfg.get('invalidField', 'pid')
    shape = cfg.get('invalidShape', 'missing')
    if field not in ('pid', 'processStartTime', 'generation'):
        raise ValueError(f'unknown invalidField {field!r}')
    shapes = {
        'missing': None,
        'null': None,
        'true': True,
        'false': False,
        'zero': 0,
        'negative': -1,
        'string': '5',
        'list': [5],
        'object': {},
    }
    if shape not in shapes:
        raise ValueError(f'unknown invalidShape {shape!r}')
    if shape == 'missing':
        body.pop(field, None)
    else:
        body[field] = shapes[shape]
    return body


def _predecessor_entries(cfg, workspace, live, dead):
    mode = cfg.get('predecessor', 'dead')
    uuid = cfg.get('predecessorUuid', cfg['oldNativeId'])
    owner = cfg['oldOwner']
    if mode == 'missing':
        return []
    if mode == 'live':
        return [{'name': f'{owner}.json', 'raw': None,
                 'body': predecessor_manifest(uuid, workspace, live[0], live[1], state='done')}]
    if mode == 'different_start':
        return [{'name': f'{owner}.json', 'raw': None,
                 'body': predecessor_manifest(uuid, workspace, live[0], live[1] - 300, state='done')}]
    if mode == 'different_filename':
        return [{'name': 'predecessor-alias.json', 'raw': None,
                 'body': predecessor_manifest(uuid, workspace, live[0], live[1], state='done')}]
    if mode == 'dead':
        return [{'name': f'{owner}.json', 'raw': None,
                 'body': predecessor_manifest(uuid, workspace, dead, 1700000000, state='done')}]
    if mode == 'invalid_identity':
        return [{'name': f'{owner}.json', 'raw': None,
                 'body': _invalid_identity_body(cfg, workspace, live, dead)}]
    if mode == 'contradictory_session':
        body = predecessor_manifest(uuid, workspace, dead, 1700000000, state='done')
        body['sessionId'] = 'feedface-0000-4000-8000-000000000000'
        return [{'name': f'{owner}.json', 'raw': None, 'body': body}]
    if mode == 'contradictory_alias':
        body = predecessor_manifest(uuid, workspace, dead, 1700000000, state='done')
        body['fullUuid'] = 'feedface-0000-4000-8000-000000000000'
        return [{'name': f'{owner}.json', 'raw': None, 'body': body}]
    if mode in ('alias_null', 'alias_zero', 'alias_false', 'alias_empty', 'alias_list', 'alias_object'):
        # An otherwise valid dead exact-match manifest whose sessionId alias is
        # PRESENT but not a nonempty string. Null must be treated as present, not
        # absent, and every non-string/empty value must fail exact identity.
        body = predecessor_manifest(uuid, workspace, dead, 1700000000, state='done')
        shapes = {
            'alias_null': None,
            'alias_zero': 0,
            'alias_false': False,
            'alias_empty': '',
            'alias_list': [],
            'alias_object': {},
        }
        body['sessionId'] = shapes[mode]
        return [{'name': f'{owner}.json', 'raw': None, 'body': body}]
    if mode == 'alias_conflict':
        body = predecessor_manifest(uuid, workspace, dead, 1700000000, state='done')
        body['sessionId'] = 'feedface-0000-4000-8000-000000000000'
        body['fullUUID'] = uuid
        return [{'name': f'{owner}.json', 'raw': None, 'body': body}]
    if mode in ('alias_null_fulluuid', 'alias_null_fulluuid_lower'):
        # Present-null on the other two alias keys, with the remaining aliases
        # valid, so only the null-must-be-rejected rule refuses this manifest.
        body = predecessor_manifest(uuid, workspace, dead, 1700000000, state='done')
        body['fullUUID' if mode == 'alias_null_fulluuid' else 'fullUuid'] = None
        return [{'name': f'{owner}.json', 'raw': None, 'body': body}]
    if mode == 'alias_absent_session':
        # F-023 regression guard: the sessionId key is OMITTED entirely and only
        # fullUUID carries the identity. An absent alias is optional, so this is
        # an otherwise valid dead exact match and must take the normal commit
        # path (baseline 23b4b7b also commits; not one of the baseline-red F1 cases).
        body = predecessor_manifest(uuid, workspace, dead, 1700000000, state='done')
        body.pop('sessionId', None)
        return [{'name': f'{owner}.json', 'raw': None, 'body': body}]
    if mode == 'alias_nonstring_alone':
        # F-024 regression guard: a single PRESENT alias with a non-string value
        # (0) and no other alias keys. The nonempty-string type guard is the only
        # rule that can refuse this record, so the refusal must carry the exact
        # no-exact-native-identity reason (baseline 23b4b7b also refuses it; not
        # one of the baseline-red F1 cases).
        body = predecessor_manifest(uuid, workspace, dead, 1700000000, state='done')
        body['sessionId'] = 0
        body.pop('fullUUID', None)
        body.pop('fullUuid', None)
        return [{'name': f'{owner}.json', 'raw': None, 'body': body}]
    if mode == 'canonical_plus_contradictory_live':
        # F2 two-record case: a canonical valid dead exact-match manifest named
        # after oldOwner, plus a differently named readable manifest that claims
        # the SAME fullUUID as the expected identity while contradicting it with a
        # different sessionId, harness and workspace, backed by a live process.
        # The second record is relevant (same fullUUID) and must refuse as
        # unknown, never fall through to the canonical dead record's 'gone'.
        other_workspace = os.path.join(workspace, 'contradictory')
        os.makedirs(other_workspace, mode=0o700, exist_ok=True)
        conflicting = predecessor_manifest(uuid, other_workspace, live[0], live[1],
                                           state='done', harness='claude-code')
        conflicting['sessionId'] = 'feedface-0000-4000-8000-000000000000'
        conflicting['fullUUID'] = uuid
        return [
            {'name': f'{owner}.json', 'raw': None,
             'body': predecessor_manifest(uuid, workspace, dead, 1700000000, state='done')},
            {'name': 'predecessor-conflict.json', 'raw': None, 'body': conflicting}]
    if mode == 'malformed':
        return [{'name': f'{owner}.json', 'raw': '{not-json'}]
    if mode == 'duplicate_keys':
        raw = ('{"fullUUID": "%s", "fullUUID": "%s", "worktree": "%s", "harness": "codex", '
               '"pid": %d, "processStartTime": 1700000000, "state": "done"}' % (uuid, uuid, workspace, dead))
        return [{'name': f'{owner}.json', 'raw': raw}]
    if mode == 'nonfinite':
        raw = ('{"fullUUID": "%s", "worktree": "%s", "harness": "codex", '
               '"pid": %d, "processStartTime": NaN, "state": "done"}' % (uuid, workspace, dead))
        return [{'name': f'{owner}.json', 'raw': raw}]
    if mode in ('conflict_provider', 'conflict_workspace'):
        other_workspace = workspace if mode == 'conflict_provider' else os.path.join(workspace, 'elsewhere')
        other_harness = 'claude-code' if mode == 'conflict_provider' else 'codex'
        os.makedirs(other_workspace, mode=0o700, exist_ok=True)
        return [
            {'name': f'{owner}.json', 'raw': None,
             'body': predecessor_manifest(uuid, workspace, dead, 1700000000, state='done')},
            {'name': 'predecessor-secondary.json', 'raw': None,
             'body': predecessor_manifest(uuid, other_workspace, dead + 1, 1700000001,
                                          state='done', harness=other_harness)}]
    raise ValueError(f'unknown predecessor mode {mode!r}')


def run_gate(cfg):
    """Run the real gate against disposable canonical roots and report evidence."""
    root = tempfile.mkdtemp(prefix='successor-authority-fixture-')
    children = []
    try:
        workspace = os.path.join(root, 'workspace')
        os.makedirs(workspace, mode=0o700)
        workers = os.path.join(root, 'workers')
        sessions = os.path.join(root, 'sessions')
        lock_dir = os.path.join(root, 'lock')
        state_dir = os.path.join(root, 'state')
        for path in (workers, sessions, lock_dir, state_dir):
            os.makedirs(path, mode=0o700)
        lock_file = os.path.join(lock_dir, 'conductor.lock.json')
        beacon = os.path.join(lock_dir, cfg['conductorId'])
        write_text(beacon, 'beacon\n')

        dead = spawn_dead()
        live = (dead, 1700000000)
        if cfg.get('predecessor') in ('live', 'different_start', 'different_filename',
                                      'canonical_plus_contradictory_live') or (
                cfg.get('predecessor') == 'invalid_identity' and not cfg.get('invalidDead')):
            child, pid, started = spawn_live()
            children.append(child)
            live = (pid, started)

        for entry in _predecessor_entries(cfg, workspace, live, dead):
            path = os.path.join(workers, entry['name'])
            if entry['raw'] is not None:
                write_text(path, entry['raw'])
            else:
                write_json(path, entry['body'])
        for entry in cfg.get('extraManifests', []):
            write_json(os.path.join(workers, entry['name']), entry['body'])

        successor_child, successor_pid, successor_start = spawn_live()
        children.append(successor_child)
        transcript = write_transcript(root, cfg['succNativeId'])
        worker_path = os.path.join(workers, f"{cfg['succOwner']}.json")
        write_json(worker_path, successor_manifest(cfg['succNativeId'], cfg['succOwner'], workspace,
                                                   successor_pid, successor_start,
                                                   generation=cfg.get('fromGeneration', 1)))

        marker = os.path.join(root, 'commit-marker.json')
        if cfg.get('realCli'):
            cli_path = os.path.join(ROOT, 'src', 'cli.js')
        else:
            cli_path = os.path.join(root, 'marker-child.cjs')
            write_text(cli_path, MARKER_CHILD)

        identity = {'repo_key': cfg['repoKey'], 'vendor': cfg['provider'], 'beacon': beacon}
        inspect = {
            'repo_key': cfg['repoKey'], 'vendor': cfg['provider'],
            'slot': {'state': 'HELD', 'vendor': cfg['provider'], 'beacon': beacon,
                     'owner': cfg['succOwner'], 'history': build_history(cfg)},
        }
        lock_stub = os.path.join(root, 'lock-stub.py')
        write_text(lock_stub, LOCK_STUB, 0o700)
        lock_spec = os.path.join(root, 'lock-spec.json')
        write_json(lock_spec, {'identity': identity, 'inspect': inspect})

        argv = [GATE_PATH,
                '--lock-script', lock_stub, '--repo', cfg['repo'], '--repo-key', cfg['repoKey'],
                '--provider', cfg['provider'], '--conductor-id', cfg['conductorId'],
                '--channel-id', cfg['channelId'], '--from-native-id', cfg['oldNativeId'],
                '--from-generation', str(cfg.get('fromGeneration', 1)), '--from-workspace', workspace,
                '--native-id', cfg['succNativeId'], '--workspace', workspace,
                '--session-file', transcript, '--worker-file', worker_path,
                '--node-path', NODE_PATH, '--cli-path', cli_path,
                '--state-dir', state_dir, '--db', os.path.join(state_dir, 'state.sqlite')]
        if cfg.get('reuse'):
            argv.append('--reuse')
        if cfg.get('fromEndpoint'):
            argv += ['--from-endpoint', cfg['fromEndpoint']]

        wrapper = os.path.join(root, 'gate-wrapper.py')
        write_text(wrapper, WRAPPER, 0o700)
        mocks = {'argv': argv, 'gate': GATE_PATH,
                 'eperm': bool(cfg.get('eperm')), 'unknownStartPid': None}
        if cfg.get('unknownStart'):
            mocks['unknownStartPid'] = live[0]
        if cfg.get('mutationPredecessor'):
            mocks['mutationPredecessor'] = {
                'after': cfg['mutationPredecessor']['after'],
                'set': cfg['mutationPredecessor']['set'],
                'path': os.path.join(workers, f"{cfg['oldOwner']}.json")}
        if cfg.get('mutationPredecessorReplace'):
            mocks['mutationPredecessorReplace'] = {
                'after': cfg['mutationPredecessorReplace']['after'],
                'path': os.path.join(workers, f"{cfg['oldOwner']}.json")}
        if cfg.get('replaceAfterRead'):
            mocks['replaceAfterRead'] = {
                'after': cfg['replaceAfterRead']['after'],
                'path': os.path.join(workers, f"{cfg['oldOwner']}.json")}
        if cfg.get('mutationSuccessor'):
            mocks['mutationSuccessor'] = {
                'after': cfg['mutationSuccessor']['after'],
                'set': cfg['mutationSuccessor']['set'],
                'path': worker_path}
        mocks_path = os.path.join(root, 'mocks.json')
        write_json(mocks_path, mocks)

        env = {**os.environ,
               'CONDUCTOR_LOCK_FILE': lock_file,
               'CONDUCTOR_WORKERS_DIR': workers,
               'CONDUCTOR_CODEX_SESSIONS_DIR': sessions,
               'CONDUCTOR_CLAUDE_PROJECTS_DIR': os.path.join(root, 'claude-projects'),
               'DISCORD_SURFACE_FIXTURE_LOCK_SPEC': lock_spec,
               MARKER_ENV: marker,
               WRAPPER_ENV: mocks_path,
               WRAPPER_SRC_ENV: SRC}
        if cfg.get('preCarryEnv') is not None:
            env[CARRY_ENV] = cfg['preCarryEnv']
        result = subprocess.run([sys.executable, wrapper], capture_output=True, text=True,
                                timeout=30, env=env, cwd=root)
        marker_data = None
        if os.path.exists(marker):
            with open(marker, 'r', encoding='utf-8') as handle:
                marker_data = json.load(handle)
        return {
            'status': result.returncode,
            'stdout': result.stdout,
            'stderr': result.stderr,
            'refused': result.returncode == 2 and 'REFUSED:' in result.stderr,
            'committed': marker_data is not None,
            'child': marker_data,
        }
    finally:
        for child in children:
            stop_child(child)
        shutil.rmtree(root, ignore_errors=True)


SCENARIOS = {
    'qualified_steal': {},
    'live_predecessor': {'predecessor': 'live'},
    'missing_predecessor': {'predecessor': 'missing'},
    'malformed_predecessor': {'predecessor': 'malformed'},
    'different_filename': {'predecessor': 'different_filename'},
    'conflict_provider': {'predecessor': 'conflict_provider'},
    'conflict_workspace': {'predecessor': 'conflict_workspace'},
    'different_start': {'predecessor': 'different_start'},
    'eperm': {'predecessor': 'dead', 'eperm': True},
    'unknown_start': {'predecessor': 'live', 'unknownStart': True},
    'override': {'historyKind': 'override'},
    'preempt': {'historyKind': 'preempt'},
    'wrong_predecessor': {'predecessorUuid': 'deadbeef-0000-4000-8000-000000000000'},
    'successor_change': {'mutationSuccessor': {'after': 1, 'set': {'generation': 2}}},
    'predecessor_change': {'predecessor': 'dead',
                           'mutationPredecessor': {'after': 2, 'set': {'processStartTime': 1700000002}}},
    'intervening': {'history': [
        _row('2026-09-28 00:00', 'release', 'session-codex-9caa5d21', 'release predecessor'),
        _row('2026-09-28 00:01', 'claim', 'session-codex-9caa5d21', 'claim predecessor'),
        _row('2026-09-28 00:02', 'steal', 'session-codex-7b7b7b7b', 'death proof'),
        _row('2026-09-28 00:03', 'claim', 'session-codex-deadbeef', 'later foreign claim')]},
    'normal_release_claim': {'historyKind': 'normal'},
    'reuse_after_steal': {'reuse': True},
    'duplicate_keys': {'predecessor': 'duplicate_keys'},
    'nonfinite': {'predecessor': 'nonfinite'},
    'invalid_identity': {'predecessor': 'invalid_identity',
                         'invalidField': 'pid', 'invalidShape': 'missing'},
    'contradictory_session': {'predecessor': 'contradictory_session'},
    'contradictory_alias': {'predecessor': 'contradictory_alias'},
    'extra_invalid_identity': {'extraManifests': [{
        'name': 'predecessor-noise.json',
        'body': {
            'sessionId': 'feedface-0000-4000-8000-000000000000',
            'fullUUID': 'feedface-0000-4000-8000-000000000000',
            'worktree': '/tmp/predecessor-noise-workspace',
            'state': 'done',
            'harness': 'codex',
            'pid': 'not-an-int',
            'processStartTime': 1700000000,
            'generation': 1,
        }}]},
    'steal_owner_mismatch': {'history': [
        _row('2026-09-28 00:00', 'release', 'session-codex-9caa5d21', 'release predecessor'),
        _row('2026-09-28 00:01', 'claim', 'session-codex-9caa5d21', 'claim predecessor'),
        _row('2026-09-28 00:02', 'steal', 'session-codex-0badc0de', 'death proof')]},
    'steal_owner_mismatch_reuse': {'reuse': True, 'history': [
        _row('2026-09-28 00:00', 'release', 'session-codex-9caa5d21', 'release predecessor'),
        _row('2026-09-28 00:01', 'claim', 'session-codex-9caa5d21', 'claim predecessor'),
        _row('2026-09-28 00:02', 'steal', 'session-codex-0badc0de', 'death proof')]},
    'release_then_steal': {'history': [
        _row('2026-09-28 00:00', 'release', 'session-codex-9caa5d21', 'release predecessor'),
        _row('2026-09-28 00:01', 'steal', 'session-codex-7b7b7b7b', 'death proof')]},
    'predecessor_inode_replace': {'predecessor': 'dead',
                                  'mutationPredecessorReplace': {'after': 2}},
    'predecessor_rewrite_in_place': {'predecessor': 'dead',
                                     'mutationPredecessor': {'after': 2, 'set': {}}},
    'alias_null': {'predecessor': 'alias_null'},
    'alias_zero': {'predecessor': 'alias_zero'},
    'alias_false': {'predecessor': 'alias_false'},
    'alias_empty': {'predecessor': 'alias_empty'},
    'alias_list': {'predecessor': 'alias_list'},
    'alias_object': {'predecessor': 'alias_object'},
    'alias_conflict': {'predecessor': 'alias_conflict'},
    'alias_null_fulluuid': {'predecessor': 'alias_null_fulluuid'},
    'alias_null_fulluuid_lower': {'predecessor': 'alias_null_fulluuid_lower'},
    'alias_absent_session': {'predecessor': 'alias_absent_session'},
    'alias_nonstring_alone': {'predecessor': 'alias_nonstring_alone'},
    'canonical_plus_contradictory_live': {'predecessor': 'canonical_plus_contradictory_live'},
    'predecessor_replace_after_read': {'predecessor': 'dead',
                                       'replaceAfterRead': {'after': 2}},
}


def run_scenario(name, overrides=None):
    if name not in SCENARIOS:
        raise ValueError(f'unknown scenario {name!r}')
    cfg = {
        'repo': 'https://github.com/example/discord-pickup.git',
        'repoKey': 'github.com/example/discord-pickup',
        'provider': 'codex',
        'conductorId': 'conductor-authority.md',
        'channelId': 'authority-channel',
        'oldNativeId': '9caa5d21-2169-429d-918b-5f08651b5dbd',
        'succNativeId': '7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b',
        'oldOwner': 'session-codex-9caa5d21',
        'succOwner': 'session-codex-7b7b7b7b',
        'fromGeneration': 1,
        'predecessor': 'dead',
    }
    cfg.update(SCENARIOS[name])
    if overrides:
        cfg.update(overrides)
    return run_gate(cfg)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('command', choices=['run', 'list'])
    parser.add_argument('scenario', nargs='?')
    parser.add_argument('config', nargs='?')
    options = parser.parse_args()
    if options.command == 'list':
        print(json.dumps(sorted(SCENARIOS)))
        return 0
    overrides = json.loads(options.config) if options.config else None
    print(json.dumps(run_scenario(options.scenario, overrides)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
