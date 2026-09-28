#!/usr/bin/env python3
import argparse
import fcntl
import hashlib
import json
import os
import stat
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conductor_worker_proof import (  # noqa: E402
    FORCED_VERBS,
    GateError,
    OWNER_CHANGE_VERBS,
    capture_snapshot,
    discover_predecessor,
    fail,
    native_token,
    owner_token,
    snapshots_differ,
    verify_transcript,
    verify_worker,
)


CARRY_ENV = 'DISCORD_SURFACE_HANDOFF_CARRY_ACCEPTED_HUMAN'


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


def expected_predecessor_owner(history):
    """Return the prior owner of the latest owner-changing event when it is a steal."""
    if not isinstance(history, list):
        return None
    latest = None
    latest_index = None
    for index, row in enumerate(history):
        if isinstance(row, dict) and row.get('verb') in OWNER_CHANGE_VERBS:
            latest = row
            latest_index = index
    if latest is None or latest.get('verb') != 'steal':
        return None
    prior = next((history[position] for position in range(latest_index - 1, -1, -1)
                  if isinstance(history[position], dict) and history[position].get('verb') in OWNER_CHANGE_VERBS), None)
    return prior.get('who') if isinstance(prior, dict) else None


def bound_predecessor_identity(from_native_id, provider, from_workspace):
    if not from_native_id or not from_workspace:
        return None
    return {
        'fullUUID': from_native_id,
        'provider': provider,
        'workspace': os.path.realpath(os.path.abspath(from_workspace)),
    }


def steal_and_id(history, steal, steal_index, provider, native_id, from_native_id, from_workspace,
                 old_binding, require_predecessor, predecessor):
    prior = next((history[position] for position in range(steal_index - 1, -1, -1)
                  if history[position].get('verb') in OWNER_CHANGE_VERBS), None)
    if not isinstance(prior, dict):
        fail('canonical steal has no identifiable prior owner')
    if prior.get('verb') == 'release':
        fail('canonical steal predecessor record does not establish ownership')
    if prior.get('who') == steal.get('who'):
        fail('canonical steal does not follow a different prior owner')
    for row in history[steal_index + 1:]:
        if row.get('verb') in OWNER_CHANGE_VERBS and row.get('who') != steal.get('who'):
            fail('conductor lock changed owner after the identified steal')
    if require_predecessor:
        if owner_token(prior.get('who'), provider) != native_token(from_native_id):
            fail('canonical steal predecessor does not match the existing binding native UUID')
        expected = bound_predecessor_identity(from_native_id, provider, from_workspace)
        status = (predecessor or {}).get('status')
        if status != 'gone':
            reason = (predecessor or {}).get('reason') or 'no death proof was available'
            fail(f'canonical steal predecessor is not proven gone: {reason}')
        record = (predecessor or {}).get('record') or {}
        record_provider = 'claude' if record.get('harness') == 'claude-code' else 'codex'
        record_workspace = record.get('worktree')
        if (record.get('fullUUID') != expected.get('fullUUID') or record_provider != expected.get('provider')
                or not isinstance(record_workspace, str)
                or os.path.realpath(os.path.abspath(record_workspace)) != expected.get('workspace')):
            fail('canonical steal predecessor evidence does not match the bound identity')
    stable = {
        'transition': {'prior': prior, 'steal': steal},
        'oldBinding': old_binding,
        'successorNativeId': native_id,
    }
    digest = hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return steal, prior, f'lock-handoff-{digest}', bool(require_predecessor)


def transition_and_id(history, owner, provider, native_id, from_native_id, from_workspace,
                      old_binding, require_predecessor, predecessor=None):
    if not isinstance(history, list) or not history:
        fail('normal release-to-claim transition is missing from lock history')
    for row in history:
        if (not isinstance(row, dict) or not isinstance(row.get('at'), str) or
                not isinstance(row.get('verb'), str) or not isinstance(row.get('who'), str) or
                not isinstance(row.get('note'), str)):
            fail('conductor lock history contains an invalid transition')
    latest = None
    latest_index = None
    for index, row in enumerate(history):
        if row.get('verb') in OWNER_CHANGE_VERBS:
            latest = row
            latest_index = index
    if latest is None:
        fail('normal release-to-claim transition is missing from lock history')
    if latest.get('verb') in ('override', 'preempt'):
        fail('forced takeover is not a normal release-to-claim handoff')
    if latest.get('verb') == 'steal':
        if latest.get('who') != owner:
            fail('canonical steal owner does not match the held successor')
        return steal_and_id(history, latest, latest_index, provider, native_id, from_native_id,
                            from_workspace, old_binding, require_predecessor, predecessor)
    candidate = None
    release = None
    candidate_index = None
    for index, row in enumerate(history):
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
    return candidate, release, f'lock-handoff-{digest}', False


def validate_authority(readback, identity, options, *, require_predecessor, predecessor=None):
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
    _change, _prior, handoff_id, carry = transition_and_id(
        slot.get('history'), owner, options.provider, options.native_id,
        options.from_native_id, options.from_workspace, old_binding,
        require_predecessor, predecessor
    )
    verify_transcript(options.session_file, options.provider, options.native_id)
    verify_worker(options.worker_file, options.provider, options.native_id, owner, options.workspace)
    return handoff_id, carry


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
    parser.add_argument('--intake-cutoff', required=False)
    parser.add_argument('--enrollment-proof', required=False)
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
    bound_identity = bound_predecessor_identity(options.from_native_id, options.provider, options.from_workspace)
    predecessor_owner = expected_predecessor_owner(first_readback.get('slot', {}).get('history')) \
        if isinstance(first_readback.get('slot'), dict) else None
    predecessor = discover_predecessor(bound_identity, predecessor_owner) if not options.reuse else None
    first_handoff_id, carry = validate_authority(
        first_readback, first_identity, options, require_predecessor=not options.reuse, predecessor=predecessor)
    first_snapshot = capture_snapshot(options, bound_identity, predecessor_owner, include_predecessor=carry)

    parent_descriptor = open_lock_parent(lock_file)
    try:
        fcntl.flock(parent_descriptor, fcntl.LOCK_EX)
        second_identity = run_lock(options.lock_script, options.repo, options.provider, 'identity')
        second_readback = run_lock(options.lock_script, options.repo, options.provider, 'inspect')
        second_predecessor_owner = expected_predecessor_owner(second_readback.get('slot', {}).get('history')) \
            if isinstance(second_readback.get('slot'), dict) else None
        second_predecessor = discover_predecessor(bound_identity, second_predecessor_owner) if not options.reuse else None
        second_handoff_id, second_carry = validate_authority(
            second_readback, second_identity, options, require_predecessor=not options.reuse, predecessor=second_predecessor)
        if first_identity.get('beacon') != second_identity.get('beacon') or first_handoff_id != second_handoff_id:
            fail('conductor authority changed while acquiring the writer gate')
        second_snapshot = capture_snapshot(options, bound_identity, second_predecessor_owner, include_predecessor=second_carry)
        changed, detail = snapshots_differ(first_snapshot, second_snapshot)
        if changed:
            fail(f'conductor worker identity changed while acquiring the writer gate: {detail}')
        carry = bool(second_carry)
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
        if options.intake_cutoff:
            commit.extend(['--intake-cutoff', options.intake_cutoff])
        if options.enrollment_proof:
            commit.extend(['--enrollment-proof', options.enrollment_proof])
        if options.reuse:
            commit.append('--reuse')
        else:
            commit.extend(['--handoff-id', second_handoff_id])
        child_env = {**os.environ, 'DISCORD_SURFACE_HANDOFF_GATE_HELD': '1'}
        child_env.pop(CARRY_ENV, None)
        if carry and not options.reuse:
            child_env[CARRY_ENV] = '1'
        try:
            # The child must retain the directory lock if this gate process is terminated by its caller.
            result = subprocess.run(
                commit, check=False, capture_output=True, text=True, timeout=30,
                env=child_env,
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
