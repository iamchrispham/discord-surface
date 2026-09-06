#!/usr/bin/env python3
import argparse
import datetime
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys


OWNER_CHANGE_VERBS = frozenset({'claim', 'release', 'steal', 'override', 'preempt'})
FORCED_VERBS = frozenset({'steal', 'override', 'preempt'})
PROOF_LIMIT = 1024 * 1024


class GateError(Exception):
    pass


def fail(message):
    raise GateError(message)


def read_regular(path, label, limit=PROOF_LIMIT, first_line=False):
    try:
        before = os.lstat(path)
    except OSError as error:
        fail(f'{label} cannot be read: {error}')
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        fail(f'{label} must be a single-link regular file')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        fail(f'{label} cannot be opened safely: {error}')
    try:
        after = os.fstat(descriptor)
        if (not stat.S_ISREG(after.st_mode) or after.st_nlink != 1 or
                (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)):
            fail(f'{label} changed identity while opening')
        chunks = []
        size = 0
        while size <= limit:
            chunk = os.read(descriptor, min(65536, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if first_line and b'\n' in b''.join(chunks):
                break
        if size > limit:
            fail(f'{label} exceeds the {limit} byte proof limit')
        return b''.join(chunks)
    finally:
        os.close(descriptor)


def read_json(path, label):
    try:
        value = json.loads(read_regular(path, label).decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f'{label} is not valid JSON: {error}')
    if not isinstance(value, dict):
        fail(f'{label} must contain a JSON object')
    return value


def native_token(native_id):
    return native_id.split('-', 1)[0].lower()


def owner_token(owner, provider):
    prefix = f'session-{provider}-'
    if not isinstance(owner, str) or not owner.startswith(prefix):
        return None
    token = owner[len(prefix):].split('-', 1)[0].lower()
    return token if re.fullmatch(r'[0-9a-f]{8}', token) else None


def verify_transcript(path, provider, native_id):
    root_name = 'CONDUCTOR_CLAUDE_PROJECTS_DIR' if provider == 'claude' else 'CONDUCTOR_CODEX_SESSIONS_DIR'
    configured_root = os.environ.get(root_name)
    default_root = '~/.claude/projects' if provider == 'claude' else '~/.codex/sessions'
    root = os.path.realpath(os.path.abspath(configured_root or os.path.expanduser(default_root)))
    requested = os.path.abspath(path)
    resolved = os.path.realpath(requested)
    try:
        inside = os.path.commonpath([resolved, root]) == root
    except ValueError:
        inside = False
    if not inside:
        fail('session transcript is outside the canonical provider transcript root')
    name = os.path.basename(resolved)
    if provider == 'claude':
        if name != f'{native_id}.jsonl':
            fail('Claude session transcript filename does not match the native UUID')
    elif not re.fullmatch(rf'rollout-.*-{re.escape(native_id)}\.jsonl', name):
        fail('Codex session transcript filename does not match the native UUID')
    raw = read_regular(requested, 'session transcript', limit=65536, first_line=True)
    first = next((line for line in raw.splitlines() if line.strip()), None)
    if first is None:
        fail('session transcript header is absent')
    try:
        header = json.loads(first.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f'session transcript header is invalid: {error}')
    if provider == 'claude':
        observed = header.get('sessionId') if isinstance(header, dict) else None
    else:
        payload = header.get('payload') if isinstance(header, dict) else None
        if not isinstance(header, dict) or header.get('type') != 'session_meta' or not isinstance(payload, dict):
            fail('Codex session transcript header is not a session_meta event')
        observed = payload.get('id') or payload.get('session_id')
    if observed != native_id:
        fail('session transcript header does not match the requested native UUID')


def process_start_time(pid):
    try:
        probe = subprocess.run(
            ['ps', '-p', str(pid), '-o', 'lstart='],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if probe.returncode != 0 or not probe.stdout.strip():
        return None
    try:
        value = ' '.join(probe.stdout.split())
        return int(datetime.datetime.strptime(value, '%a %b %d %H:%M:%S %Y').timestamp())
    except (OverflowError, ValueError):
        return None


def verify_worker(path, provider, native_id, owner, workspace):
    worker = read_json(path, 'worker manifest')
    lane_id = worker.get('laneId')
    if owner_token(lane_id, provider) != owner_token(owner, provider):
        fail('worker manifest lane token does not match the current lock owner')
    session_id = worker.get('sessionId')
    full_uuid = worker.get('fullUUID') or worker.get('fullUuid')
    if session_id is not None and session_id != native_id:
        fail('worker manifest session does not match the requested native UUID')
    if full_uuid is not None and full_uuid != native_id:
        fail('worker manifest full UUID does not match the requested native UUID')
    if session_id is None and full_uuid is None:
        fail('worker manifest has no exact native session identity')
    expected_worktree = os.path.realpath(os.path.abspath(workspace))
    actual_worktree = worker.get('worktree')
    if not isinstance(actual_worktree, str) or os.path.realpath(os.path.abspath(actual_worktree)) != expected_worktree:
        fail('worker manifest worktree does not match the requested workspace')
    expected_harness = 'claude-code' if provider == 'claude' else 'codex'
    if worker.get('harness') != expected_harness:
        fail('worker manifest harness does not match the requested provider')
    if worker.get('state') != 'active':
        fail('worker manifest is not active')
    generation = worker.get('generation')
    pid = worker.get('pid')
    started = worker.get('processStartTime')
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 1:
        fail('worker manifest has no valid process generation')
    if isinstance(pid, bool) or not isinstance(pid, int) or pid < 1:
        fail('worker manifest has no valid pid')
    if isinstance(started, bool) or not isinstance(started, int) or started < 1:
        fail('worker manifest has no valid process start time')
    try:
        os.kill(pid, 0)
    except OSError as error:
        fail(f'worker process is not live: {error}')
    observed = process_start_time(pid)
    if observed is None or observed != started:
        fail('worker process generation does not match the manifest')


def run_lock(lock_script, repo, provider, verb):
    try:
        result = subprocess.run(
            [lock_script, '--repo', repo, '--vendor', provider, verb],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
            env=os.environ.copy(),
        )
    except (OSError, subprocess.SubprocessError) as error:
        fail(f'conductor lock {verb} failed to run: {error}')
    if result.returncode != 0:
        fail(f'conductor lock {verb} refused authority: {result.stderr.strip()}')
    try:
        value = json.loads(result.stdout.strip())
    except (json.JSONDecodeError, TypeError) as error:
        fail(f'conductor lock {verb} returned invalid readback: {error}')
    if not isinstance(value, dict):
        fail(f'conductor lock {verb} returned a non-object readback')
    return value


def transition_and_id(history, owner, provider, native_id, from_native_id, old_binding, require_predecessor):
    if not isinstance(history, list) or not history:
        fail('normal release-to-claim transition is missing from lock history')
    candidate = None
    release = None
    candidate_index = None
    for index, row in enumerate(history):
        if (not isinstance(row, dict) or not isinstance(row.get('at'), str) or
                not isinstance(row.get('verb'), str) or not isinstance(row.get('who'), str) or
                not isinstance(row.get('note'), str)):
            fail('conductor lock history contains an invalid transition')
        if row.get('verb') != 'claim' or row.get('who') != owner:
            continue
        previous = next((history[position] for position in range(index - 1, -1, -1)
                         if history[position].get('verb') in OWNER_CHANGE_VERBS), None)
        if isinstance(previous, dict) and previous.get('verb') == 'release' and previous.get('who') != owner:
            candidate = row
            release = previous
            candidate_index = index
    if candidate is None or release is None:
        forced = next((row for row in reversed(history)
                       if isinstance(row, dict) and row.get('verb') in FORCED_VERBS), None)
        if forced is not None:
            fail('forced takeover is not a normal release-to-claim handoff')
        fail('normal release-to-claim transition is missing from lock history')
    if require_predecessor and owner_token(release.get('who'), provider) != native_token(from_native_id):
        fail('normal release predecessor does not match the existing binding native UUID')
    if not require_predecessor and owner_token(release.get('who'), provider) == native_token(native_id):
        fail('successor claim does not have a distinct predecessor')
    for row in history[candidate_index + 1:]:
        verb = row.get('verb')
        if verb in OWNER_CHANGE_VERBS and not (verb == 'claim' and row.get('who') == owner):
            fail('conductor lock changed owner after the verified successor claim')
    stable = {
        'transition': {'release': release, 'claim': candidate},
        'oldBinding': old_binding,
        'successorNativeId': native_id,
    }
    digest = hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return candidate, release, f'lock-handoff-{digest}'


def validate_authority(readback, identity, options, *, require_predecessor):
    if readback.get('repo_key') != options.repo_key or readback.get('vendor') != options.provider:
        fail('conductor lock repository or vendor does not match the request')
    if identity.get('repo_key') != options.repo_key or identity.get('vendor') != options.provider:
        fail('conductor lock identity does not match the request')
    beacon = identity.get('beacon')
    if not isinstance(beacon, str) or os.path.basename(beacon) != options.conductor_id:
        fail('conductor ID is not the exact basename of identity.beacon')
    slot = readback.get('slot')
    if not isinstance(slot, dict) or slot.get('state') != 'HELD':
        fail('conductor lock is not HELD by the successor')
    if slot.get('vendor') != options.provider or slot.get('beacon') != beacon:
        fail('conductor lock beacon or vendor does not match identity')
    owner = slot.get('owner')
    if owner_token(owner, options.provider) != native_token(options.native_id):
        fail('conductor lock owner does not match the requested native UUID')
    old_binding = {
        'channelId': options.channel_id,
        'provider': options.provider,
        'conductorId': options.conductor_id,
        'repoKey': options.repo_key,
        'nativeId': options.from_native_id,
        'generation': options.from_generation,
        'workspace': options.from_workspace,
        'endpoint': options.from_endpoint,
    }
    _claim, _release, handoff_id = transition_and_id(
        slot.get('history'), owner, options.provider, options.native_id,
        options.from_native_id, old_binding, require_predecessor
    )
    verify_transcript(options.session_file, options.provider, options.native_id)
    verify_worker(options.worker_file, options.provider, options.native_id, owner, options.workspace)
    return handoff_id


def open_lock_parent(lock_file):
    absolute = os.path.abspath(lock_file)
    parent = os.path.dirname(absolute) or os.path.abspath(os.sep)
    try:
        metadata = os.lstat(parent)
    except OSError as error:
        fail(f'cannot inspect conductor lock parent safely: {error}')
    if not stat.S_ISDIR(metadata.st_mode):
        fail('conductor lock parent must be a directory')
    flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    try:
        descriptor = os.open(parent, flags)
    except OSError as error:
        fail(f'cannot open conductor lock parent safely: {error}')
    opened = os.fstat(descriptor)
    if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev, opened.st_ino) != (metadata.st_dev, metadata.st_ino):
        os.close(descriptor)
        fail('conductor lock parent changed identity while opening')
    return descriptor


def parse_options():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--lock-script', required=True)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--repo-key', required=True)
    parser.add_argument('--provider', required=True)
    parser.add_argument('--conductor-id', required=True)
    parser.add_argument('--channel-id', required=True)
    parser.add_argument('--from-native-id', required=False)
    parser.add_argument('--from-generation', required=False, type=int)
    parser.add_argument('--from-workspace', required=False)
    parser.add_argument('--from-endpoint', required=False)
    parser.add_argument('--native-id', required=True)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--session-file', required=True)
    parser.add_argument('--worker-file', required=True)
    parser.add_argument('--node-path', required=True)
    parser.add_argument('--cli-path', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--db', required=True)
    parser.add_argument('--endpoint', required=False)
    parser.add_argument('--reuse', action='store_true')
    return parser.parse_args()


def main():
    options = parse_options()
    if not os.path.isabs(options.lock_script):
        fail('conductor lock script must be an absolute path')
    if options.reuse:
        if options.from_native_id is None or options.from_generation is None:
            fail('reuse proof requires the current binding identity')
    else:
        if options.from_native_id is None or options.from_generation is None:
            fail('handoff proof requires the existing binding identity')
        if options.from_native_id == options.native_id:
            fail('successor handoff requires a different native session UUID')
    if not fcntl:
        fail('filesystem locking is unavailable')
    for path, label in ((options.node_path, 'node path'), (options.cli_path, 'CLI path')):
        if not os.path.isabs(path):
            fail(f'{label} must be absolute')
    for path, label in ((options.state_dir, 'state directory'), (options.db, 'database path')):
        if not os.path.isabs(path):
            fail(f'{label} must be absolute')

    lock_file = os.path.abspath(os.environ.get('CONDUCTOR_LOCK_FILE', os.path.expanduser('~/.agents/conductor.lock.json')))
    first_identity = run_lock(options.lock_script, options.repo, options.provider, 'identity')
    first_readback = run_lock(options.lock_script, options.repo, options.provider, 'inspect')
    first_handoff_id = validate_authority(first_readback, first_identity, options, require_predecessor=not options.reuse)

    parent_descriptor = open_lock_parent(lock_file)
    try:
        fcntl.flock(parent_descriptor, fcntl.LOCK_EX)
        second_identity = run_lock(options.lock_script, options.repo, options.provider, 'identity')
        second_readback = run_lock(options.lock_script, options.repo, options.provider, 'inspect')
        second_handoff_id = validate_authority(second_readback, second_identity, options, require_predecessor=not options.reuse)
        if first_identity.get('beacon') != second_identity.get('beacon') or first_handoff_id != second_handoff_id:
            fail('conductor authority changed while acquiring the writer gate')
        commit = [
            options.node_path, options.cli_path, 'handoff-local',
            '--state-dir', options.state_dir, '--db', options.db,
            '--provider', options.provider, '--conductor-id', options.conductor_id,
            '--repo-key', options.repo_key, '--channel-id', options.channel_id,
            '--from-native-id', options.from_native_id, '--from-generation', str(options.from_generation),
            '--native-id', options.native_id, '--workspace', options.workspace
        ]
        if options.endpoint:
            commit.extend(['--endpoint', options.endpoint])
        if options.reuse:
            commit.append('--reuse')
        else:
            commit.extend(['--handoff-id', second_handoff_id])
        try:
            # The child must retain the directory lock if this gate process is terminated by its caller.
            result = subprocess.run(
                commit, check=False, capture_output=True, text=True, timeout=30,
                env={**os.environ, 'DISCORD_SURFACE_HANDOFF_GATE_HELD': '1'},
                pass_fds=(parent_descriptor,)
            )
        except (OSError, subprocess.SubprocessError) as error:
            fail(f'local handoff commit failed to run: {error}')
        if result.stdout:
            sys.stdout.write(result.stdout)
        if result.stderr:
            sys.stderr.write(result.stderr)
        if result.returncode != 0:
            fail('local handoff commit refused the current binding or custody')
    finally:
        fcntl.flock(parent_descriptor, fcntl.LOCK_UN)
        os.close(parent_descriptor)


if __name__ == '__main__':
    try:
        main()
    except GateError as error:
        print(f'REFUSED: {error}', file=sys.stderr)
        raise SystemExit(2)
