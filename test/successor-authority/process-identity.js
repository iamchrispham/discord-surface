'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DARWIN_OWNER = path.join(__dirname, '..', '..', 'scripts', 'full-gate', 'darwin.py');
const OBSERVATION = Object.freeze({ PRESENT: 'present', ABSENT: 'absent', UNKNOWN: 'unknown' });
const IDENTITY_PROGRAM = String.raw`
import errno
import importlib.util
import json
import os
import sys


def emit(kind, identity=None):
    result = {'kind': kind}
    if identity is not None:
        result['identity'] = identity
    print(json.dumps(result, separators=(',', ':')))


pid = int(sys.argv[2])
if sys.platform == 'darwin':
    spec = importlib.util.spec_from_file_location('gate_darwin', sys.argv[1])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    try:
        identity = module.joined_identity(pid)
    except OSError as error:
        emit('absent' if error.errno == errno.ESRCH else 'unknown')
        raise SystemExit(0)
    except (ValueError, KeyError, TypeError, AttributeError):
        emit('unknown')
        raise SystemExit(0)
    emit('present', {'platform': 'darwin', **identity})
else:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        emit('absent')
        raise SystemExit(0)
    except OSError:
        emit('unknown')
        raise SystemExit(0)
    try:
        with open('/proc/' + str(pid) + '/stat', 'r', encoding='ascii') as handle:
            raw = handle.read()
        fields = raw[raw.rfind(')') + 2:].split()
        with open('/proc/sys/kernel/random/boot_id', 'r', encoding='ascii') as handle:
            boot_id = handle.read().strip()
        if len(fields) <= 19 or not boot_id:
            emit('unknown')
        else:
            emit('present', {
                'platform': 'linux', 'pid': pid, 'start': fields[19],
                'state': fields[0], 'boot_id': boot_id
            })
    except (OSError, ValueError, IndexError):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            emit('absent')
        except OSError:
            emit('unknown')
        else:
            emit('unknown')
`;
const SIGNAL_PROGRAM = String.raw`
import importlib.util
import json
import os
import signal
import sys

expected = json.loads(sys.argv[2])
signal_number = getattr(signal, sys.argv[3])
if sys.platform == 'darwin':
    spec = importlib.util.spec_from_file_location('gate_darwin', sys.argv[1])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    raise SystemExit(0 if module.signal_identity(expected, signal_number) else 1)

pid = int(expected['pid'])
try:
    descriptor = os.pidfd_open(pid)
except OSError:
    raise SystemExit(1)
try:
    with open('/proc/' + str(pid) + '/stat', 'r', encoding='ascii') as handle:
        raw = handle.read()
    fields = raw[raw.rfind(')') + 2:].split()
    with open('/proc/sys/kernel/random/boot_id', 'r', encoding='ascii') as handle:
        boot_id = handle.read().strip()
    if (expected.get('platform') != 'linux' or len(fields) <= 19
            or fields[19] != expected.get('start')
            or boot_id != expected.get('boot_id')):
        raise SystemExit(1)
    signal.pidfd_send_signal(descriptor, signal_number)
finally:
    os.close(descriptor)
`;

function runPython(program, args, timeout = 1000, spawn = spawnSync) {
  let result;
  try {
    result = spawn('python3', ['-I', '-c', program, DARWIN_OWNER, ...args], {
      encoding: 'utf8', timeout,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
    });
  } catch (error) {
    return { errorCode: error?.code || 'SPAWN_ERROR' };
  }
  if (result.error) return { errorCode: result.error.code || 'SPAWN_ERROR' };
  return {
    status: result.status,
    signal: result.signal,
    stdout: typeof result.stdout === 'string' ? result.stdout.trim() : ''
  };
}

function completeIdentity(identity, pid) {
  if (!identity || identity.kind !== OBSERVATION.PRESENT
      || !Number.isSafeInteger(identity.pid) || identity.pid <= 1 || identity.pid !== pid) return false;
  if (identity.platform === 'darwin') {
    return Number.isSafeInteger(identity.unique_id) && identity.unique_id > 0
      && Number.isSafeInteger(identity.pid_version) && identity.pid_version > 0
      && Number.isSafeInteger(identity.coalition_id) && identity.coalition_id > 0
      && Number.isSafeInteger(identity.start_sec) && identity.start_sec > 0
      && Number.isSafeInteger(identity.start_usec) && identity.start_usec >= 0 && identity.start_usec < 1000000;
  }
  return identity.platform === 'linux'
    && typeof identity.start === 'string' && /^[0-9]+$/.test(identity.start)
    && typeof identity.boot_id === 'string' && /^[0-9a-f-]{36}$/i.test(identity.boot_id)
    && typeof identity.state === 'string' && identity.state.length === 1;
}

function inspectIdentity(pid, invoke = runPython) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { kind: OBSERVATION.UNKNOWN, reason: 'invalid-pid' };
  const result = invoke(IDENTITY_PROGRAM, [String(pid)]);
  if (!result || result.errorCode || result.status !== 0 || result.signal) {
    return { kind: OBSERVATION.UNKNOWN, reason: result?.errorCode || 'inspection-failed' };
  }
  if (typeof result.stdout !== 'string' || result.stdout.length === 0) {
    return { kind: OBSERVATION.UNKNOWN, reason: 'empty-result' };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { kind: OBSERVATION.UNKNOWN, reason: 'malformed-result' };
  }
  if (parsed?.kind === OBSERVATION.ABSENT) return { kind: OBSERVATION.ABSENT, pid };
  const identity = { kind: OBSERVATION.PRESENT, ...parsed?.identity };
  if (parsed?.kind !== OBSERVATION.PRESENT || !completeIdentity(identity, pid)) {
    return { kind: OBSERVATION.UNKNOWN, reason: 'incomplete-result' };
  }
  return identity;
}

function sameProcessIdentity(expected, actual) {
  if (!completeIdentity(expected, expected?.pid) || !completeIdentity(actual, actual?.pid)
      || expected.pid !== actual.pid || expected.platform !== actual.platform) return false;
  const keys = expected.platform === 'darwin'
    ? ['start_sec', 'start_usec', 'unique_id', 'pid_version']
    : ['start', 'boot_id'];
  return keys.every(key => expected[key] === actual[key]);
}

function identityGone(expected, observation) {
  if (!completeIdentity(expected, expected?.pid)) return false;
  if (observation?.kind === OBSERVATION.ABSENT && observation.pid === expected.pid) return true;
  return observation?.kind === OBSERVATION.PRESENT
    && completeIdentity(observation, expected.pid)
    && !sameProcessIdentity(expected, observation);
}

function signalOwned(identity, signalName, invoke = runPython) {
  if (!completeIdentity(identity, identity?.pid)) return false;
  const result = invoke(SIGNAL_PROGRAM, [JSON.stringify(identity), signalName]);
  return Boolean(result && !result.errorCode && result.status === 0 && !result.signal
    && typeof result.stdout === 'string' && result.stdout.length === 0);
}

function rolesFromAdmission(args, inspect = inspectIdentity) {
  const holders = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '--holder') {
      const pid = Number(args[index + 1]);
      if (!Number.isSafeInteger(pid) || pid <= 1 || holders.includes(pid)) return null;
      holders.push(pid);
    }
  }
  if (holders.length < 2) return null;
  const observations = holders.map(pid => inspect(pid));
  if (observations.some(identity => identity?.kind !== OBSERVATION.PRESENT)) return null;
  return { worker: observations[0], guardian: observations[1], extraHolders: observations.slice(2) };
}

module.exports = {
  OBSERVATION, completeIdentity, inspectIdentity, captureIdentity: inspectIdentity,
  sameProcessIdentity, identityGone,
  signalOwned, rolesFromAdmission
};
