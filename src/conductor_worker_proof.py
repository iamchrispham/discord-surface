#!/usr/bin/env python3
"""Disposable worker/predecessor proof helpers for the conductor lock gate.

This companion module owns the safe-file, strict-JSON, transcript, process
liveness, worker-evidence, predecessor-proof and snapshot-comparison helpers
that src/conductor-lock-gate.py used to define inline. The gate keeps the
orchestration, transition classification, directory lock and child invocation.
"""
import datetime
import json
import os
import re
import stat
import subprocess


OWNER_CHANGE_VERBS = frozenset({'claim', 'release', 'steal', 'override', 'preempt'})
FORCED_VERBS = frozenset({'steal', 'override', 'preempt'})
PROOF_LIMIT = 1024 * 1024
IDENTITY_ALIAS_KEYS = ('sessionId', 'fullUUID', 'fullUuid')
DEFAULT_WORKERS_ROOT = '~/.agents/work-control/workers'
LEGACY_WORKERS_ROOT = '~/.codex/work-control/workers'


class GateError(Exception):
    pass


def fail(message):
    raise GateError(message)


def read_regular(path, label, limit=PROOF_LIMIT, first_line=False, with_identity=False):
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
        body = b''.join(chunks)
        if with_identity:
            # Same descriptor that produced these bytes, so the path cannot be
            # swapped underneath and re-stat'ed as if it held these bytes.
            return body, {'dev': after.st_dev, 'ino': after.st_ino}
        return body
    finally:
        os.close(descriptor)


def _strict_pairs(pairs):
    seen = set()
    for key, _value in pairs:
        if key in seen:
            raise ValueError(f'duplicate JSON key {key!r}')
        seen.add(key)
    return dict(pairs)


def _strict_constant(value):
    raise ValueError(f'non-finite JSON number {value!r} is not permitted')


def json_object(text, label):
    try:
        value = json.loads(
            text,
            object_pairs_hook=_strict_pairs,
            parse_constant=_strict_constant,
        )
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        fail(f'{label} is not valid JSON: {error}')
    if not isinstance(value, dict):
        fail(f'{label} must contain a JSON object')
    return value


def _decode_json(body, label):
    try:
        text = body.decode('utf-8')
    except UnicodeDecodeError as error:
        fail(f'{label} is not valid JSON: {error}')
    return json_object(text, label)


def read_json(path, label, with_identity=False):
    if not with_identity:
        return _decode_json(read_regular(path, label), label)
    body, identity = read_regular(path, label, with_identity=True)
    return _decode_json(body, label), identity


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


def process_probe(pid):
    """Return 'gone' | 'live' | 'unknown' plus the observed start time.

    ESRCH => gone (confirmed dead). EPERM or an unavailable/unsupported probe
    => unknown (never death). A live pid resolves to 'live' and the caller
    compares the observed start time against the recorded one.
    """
    if isinstance(pid, bool) or not isinstance(pid, int) or pid < 1:
        return 'unknown', None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return 'gone', None
    except PermissionError:
        return 'unknown', None
    except OSError:
        return 'unknown', None
    observed = process_start_time(pid)
    if observed is None:
        return 'unknown', None
    return 'live', observed


def verify_worker(path, provider, native_id, owner, workspace):
    worker = read_json(path, 'worker manifest')
    lane_id = worker.get('laneId')
    if owner_token(lane_id, provider) != owner_token(owner, provider):
        fail('worker manifest lane token does not match the current lock owner')
    identity_aliases = []
    for key in IDENTITY_ALIAS_KEYS:
        if key not in worker:
            continue
        value = worker[key]
        if not isinstance(value, str) or not value:
            fail(f'worker manifest {key} must be a nonempty string')
        if value != native_id:
            if key == 'sessionId':
                fail('worker manifest session does not match the requested native UUID')
            fail('worker manifest full UUID does not match the requested native UUID')
        identity_aliases.append(value)
    if not identity_aliases:
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


def workers_root():
    requested = os.environ.get('CONDUCTOR_WORKERS_DIR') or DEFAULT_WORKERS_ROOT
    return os.path.realpath(os.path.abspath(os.path.expanduser(requested)))


def worker_roots():
    if os.environ.get('CONDUCTOR_WORKERS_DIR'):
        return [workers_root()]
    canonical = workers_root()
    if os.path.lexists(canonical):
        return [canonical]
    legacy = os.path.realpath(os.path.abspath(os.path.expanduser(LEGACY_WORKERS_ROOT)))
    return [canonical, legacy]


def expected_filename_match(stem, expected_owner):
    if not expected_owner:
        return False
    return stem == expected_owner or stem.startswith(f'{expected_owner}-')


def predecessor_identity(worker):
    """Return the exact full identity a manifest claims, or None.

    An absent alias key is optional. A present alias must be a nonempty string,
    and every present alias must agree; otherwise the manifest cannot prove any
    exact native identity.
    """
    aliases = _identity_aliases(worker)
    if aliases is None:
        return None
    full_uuid = aliases[0][1]
    harness = worker.get('harness')
    workspace = worker.get('worktree')
    if harness == 'claude-code':
        provider = 'claude'
    elif harness == 'codex':
        provider = 'codex'
    else:
        return None
    if not isinstance(workspace, str) or not workspace:
        return None
    return {'fullUUID': full_uuid, 'provider': provider, 'workspace': os.path.realpath(os.path.abspath(workspace))}


def _identity_aliases(worker):
    if not isinstance(worker, dict):
        return None
    aliases = []
    for key in IDENTITY_ALIAS_KEYS:
        if key not in worker:
            continue
        value = worker[key]
        if not isinstance(value, str) or not value:
            return None
        aliases.append((key, value))
    if not aliases or any(value != aliases[0][1] for _key, value in aliases):
        return None
    return aliases


def _manifest_identity_fields(worker, file_identity=None):
    identity = predecessor_identity(worker)
    return {
        'fullUUID': identity['fullUUID'] if identity is not None else None,
        'pid': worker.get('pid'),
        'processStartTime': worker.get('processStartTime'),
        'generation': worker.get('generation'),
        'harness': worker.get('harness'),
        'worktree': worker.get('worktree'),
        # Device+inode come from the descriptor that produced these bytes, not
        # from a later path stat. Size is not stable identity for a predecessor:
        # an ordinary heartbeat rewrite changes it without changing authority.
        'fileIdentity': file_identity,
    }


def _canonical_symlink_target_unavailable(root):
    if os.environ.get('CONDUCTOR_WORKERS_DIR'):
        return False
    canonical = os.path.abspath(os.path.expanduser(DEFAULT_WORKERS_ROOT))
    try:
        if os.path.realpath(canonical) != root:
            return False
        current = os.path.sep
        for component in canonical.split(os.path.sep):
            if not component:
                continue
            current = os.path.join(current, component)
            if os.path.lexists(current) and os.path.islink(current) and not os.path.exists(current):
                return True
        return os.path.lexists(canonical) and not os.path.exists(canonical)
    except OSError:
        return False


def discover_predecessor(expected_identity, expected_owner):
    """Prove the bound predecessor is gone using the documented worker registries.

    Returns {'status': 'gone'|'alive'|'unknown'|'missing'|'conflict',
             'reason': str, 'record': manifest fields|None, 'filename': str|None}.
    'gone' is the only status that qualifies a steal; every other status refuses.
    """
    roots = worker_roots()
    candidates = []
    exact_matches = []
    unknown_matching = False
    unknown_reason = None
    unavailable = False
    canonical_unavailable = False
    for root in roots:
        try:
            names = sorted(name for name in os.listdir(root) if name.endswith('.json'))
        except FileNotFoundError:
            if _canonical_symlink_target_unavailable(root):
                unavailable = True
                canonical_unavailable = True
            continue
        except OSError:
            unavailable = True
            continue
        for name in names:
            stem = name[:-len('.json')]
            path = os.path.join(root, name)
            try:
                worker, file_identity = read_json(path, 'worker manifest', with_identity=True)
            except GateError as error:
                if expected_filename_match(stem, expected_owner):
                    unknown_matching = True
                    unknown_reason = f'matching predecessor manifest is unreadable: {error}'
                continue
            claimed = predecessor_identity(worker)
            if claimed is None:
                expected_uuid = expected_identity.get('fullUUID') if isinstance(expected_identity, dict) else None
                # A malformed record is still relevant when its filename matches the
                # expected owner or a string-valued alias names the expected UUID.
                claims_expected = any(
                    isinstance(worker.get(key), str) and worker.get(key) and worker.get(key) == expected_uuid
                    for key in IDENTITY_ALIAS_KEYS)
                if expected_filename_match(stem, expected_owner) or claims_expected:
                    unknown_matching = True
                    unknown_reason = 'matching predecessor manifest has no exact native identity'
                continue
            if claimed == expected_identity:
                fields = _manifest_identity_fields(worker, file_identity)
                for key in ('pid', 'processStartTime', 'generation'):
                    value = fields.get(key)
                    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                        return {'status': 'unknown', 'reason': 'predecessor manifest has invalid process identity',
                                'record': None, 'filename': stem}
                exact_matches.append({'filename': stem, 'fields': fields})
            else:
                if expected_filename_match(stem, expected_owner):
                    return {'status': 'conflict',
                            'reason': 'matching predecessor manifest claims a different native identity',
                            'record': None, 'filename': name}
                candidates.append(claimed)
    if not exact_matches:
        if unknown_matching:
            return {'status': 'unknown', 'reason': unknown_reason, 'record': None, 'filename': None}
        if canonical_unavailable:
            return {'status': 'unknown', 'reason': 'predecessor worker registry is unavailable', 'record': None, 'filename': None}
        if unavailable:
            return {'status': 'missing', 'reason': 'predecessor worker registry is unavailable', 'record': None, 'filename': None}
        return {'status': 'missing', 'reason': 'no readable manifest matches the bound predecessor identity exactly',
                'record': None, 'filename': None}
    # Conflicting records: anything that claims the same full UUID but a
    # different provider/workspace/harness is a conflict, not noise.
    conflicting = [claimed for claimed in candidates if claimed.get('fullUUID') == expected_identity.get('fullUUID')]
    if conflicting:
        return {'status': 'conflict', 'reason': 'conflicting predecessor identity records disagree',
                'record': None, 'filename': None}
    conflicts = set()
    for match in exact_matches:
        fields = match['fields']
        conflicts.add((fields.get('harness'), fields.get('pid'), fields.get('processStartTime'), fields.get('generation')))
    if len(conflicts) > 1:
        return {'status': 'conflict', 'reason': 'conflicting predecessor records disagree about process identity',
                'record': None, 'filename': None}
    alive = None
    for match in exact_matches:
        fields = match['fields']
        status, observed = process_probe(fields.get('pid'))
        if status == 'gone':
            continue
        if status == 'unknown':
            return {'status': 'unknown', 'reason': 'predecessor process liveness is unknown',
                    'record': fields, 'filename': match['filename']}
        recorded = fields.get('processStartTime')
        if isinstance(recorded, int) and not isinstance(recorded, bool) and observed == recorded:
            alive = match
            break
    if alive is not None:
        return {'status': 'alive', 'reason': 'predecessor process is still live',
                'record': alive['fields'], 'filename': alive['filename']}
    if unavailable:
        return {'status': 'unknown', 'reason': 'predecessor worker registry is unavailable',
                'record': None, 'filename': None}
    if unknown_matching:
        return {'status': 'unknown', 'reason': unknown_reason, 'record': None, 'filename': None}
    return {'status': 'gone', 'reason': 'predecessor process is confirmed gone',
            'record': exact_matches[0]['fields'], 'filename': exact_matches[0]['filename']}


def _file_identity(path):
    try:
        metadata = os.lstat(path)
    except OSError:
        return None
    return {'dev': metadata.st_dev, 'ino': metadata.st_ino, 'size': metadata.st_size}


def successor_snapshot(worker_path, provider, native_id, owner, workspace):
    """Capture the successor's own stable identity shape from its manifest."""
    try:
        worker, file_identity = read_json(worker_path, 'worker manifest', with_identity=True)
    except GateError as error:
        return {'error': str(error), 'fileIdentity': None}
    identity = predecessor_identity(worker)
    if identity is None:
        return {'error': 'worker manifest has no exact native session identity', 'fileIdentity': file_identity}
    if identity['fullUUID'] != native_id:
        return {'error': 'worker manifest native identity does not match the requested native UUID',
                'fileIdentity': file_identity}
    return {
        'laneId': worker.get('laneId'),
        'fullUUID': identity['fullUUID'],
        'sessionId': worker.get('sessionId'),
        'pid': worker.get('pid'),
        'processStartTime': worker.get('processStartTime'),
        'generation': worker.get('generation'),
        'harness': worker.get('harness'),
        'worktree': worker.get('worktree'),
        'state': worker.get('state'),
        'fileIdentity': file_identity,
    }


def capture_snapshot(options, expected_identity, expected_owner, include_predecessor=True):
    """Capture predecessor proof plus successor identity before/after the lock.

    Only identity-shape fields are recorded; heartbeat/liveness timestamps are
    deliberately excluded from the stable tuple so an ordinary lease beat does
    not read as an authority change. Reuse never demands fresh predecessor
    proof, so the predecessor half is omitted on that path.
    """
    predecessor = discover_predecessor(expected_identity, expected_owner) if include_predecessor else None
    successor = successor_snapshot(options.worker_file, options.provider,
                                   options.native_id, expected_owner, options.workspace)
    return {'predecessor': predecessor, 'successor': successor}


def _stable_predecessor(predecessor):
    if predecessor is None:
        return None
    record = predecessor.get('record')
    fields = None
    if isinstance(record, dict):
        worktree = record.get('worktree')
        fields = {
            'fullUUID': record.get('fullUUID'),
            'pid': record.get('pid'),
            'processStartTime': record.get('processStartTime'),
            'generation': record.get('generation'),
            'harness': record.get('harness'),
            'worktree': os.path.realpath(os.path.abspath(worktree)) if isinstance(worktree, str) else worktree,
            'fileIdentity': record.get('fileIdentity'),
        }
    return {
        'status': predecessor.get('status'),
        'filename': predecessor.get('filename'),
        'record': fields,
    }


def _stable_successor(successor):
    worktree = successor.get('worktree')
    return {
        'fullUUID': successor.get('fullUUID'),
        'sessionId': successor.get('sessionId'),
        'laneId': successor.get('laneId'),
        'pid': successor.get('pid'),
        'processStartTime': successor.get('processStartTime'),
        'generation': successor.get('generation'),
        'harness': successor.get('harness'),
        'state': successor.get('state'),
        'worktree': os.path.realpath(os.path.abspath(worktree)) if isinstance(worktree, str) else worktree,
        'fileIdentity': successor.get('fileIdentity'),
        'error': successor.get('error'),
    }


def stable_snapshot(snapshot):
    return {
        'predecessor': _stable_predecessor(snapshot['predecessor']),
        'successor': _stable_successor(snapshot['successor']),
    }


def snapshots_differ(before, after):
    """Return (differ, detail). Any stable identity difference must refuse."""
    left = stable_snapshot(before)
    right = stable_snapshot(after)
    if left == right:
        return False, None
    detail = f'predecessor={_stable_predecessor(before["predecessor"])} -> {_stable_predecessor(after["predecessor"])}; ' \
             f'successor={_stable_successor(before["successor"])} -> {_stable_successor(after["successor"])}'
    return True, detail
