"""Bounded Darwin process and resource-coalition operations for full gates."""

import ctypes
import errno
import os
import signal
import struct
import subprocess
import time


PROC_PIDUNIQIDENTIFIERINFO = 17
PROC_PIDCOALITIONINFO = 20
PROC_PIDTBSDINFO = 3
RESOURCE_COALITION_INDEX = 0
IDENTITY_SIZE = 56
COALITION_SIZE = 40
BSD_INFO_SIZE = 136
BSD_PID_OFFSET = 12
BSD_START_SECONDS_OFFSET = 120
BSD_START_MICROSECONDS_OFFSET = 128
RESOURCE_USAGE_SIZE = 512
POLL_SECONDS = 0.025
TERM_SECONDS = 1


class CapabilityError(OSError):
    pass


class CoalitionGone(CapabilityError):
    pass


def _apis():
    try:
        libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        kernel = ctypes.CDLL("/usr/lib/system/libsystem_kernel.dylib", use_errno=True)
        proc_pidinfo = libproc.proc_pidinfo
        coalition_info = kernel.coalition_info_resource_usage
        signal_with_token = libproc.proc_signal_with_audittoken
    except (OSError, AttributeError) as error:
        raise CapabilityError("Darwin coalition or process-identity API is unavailable") from error

    proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    proc_pidinfo.restype = ctypes.c_int
    coalition_info.argtypes = [ctypes.c_uint64, ctypes.c_void_p, ctypes.c_size_t]
    coalition_info.restype = ctypes.c_int
    signal_with_token.argtypes = [ctypes.c_void_p, ctypes.c_int]
    signal_with_token.restype = ctypes.c_int
    return proc_pidinfo, coalition_info, signal_with_token


def process_identity(pid):
    proc_pidinfo, _, _ = _apis()
    buffer = ctypes.create_string_buffer(IDENTITY_SIZE)
    ctypes.set_errno(0)
    result = proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, buffer, IDENTITY_SIZE)
    if result != IDENTITY_SIZE:
        error = ctypes.get_errno()
        if result in (-1, 0) and error == errno.ESRCH:
            raise ProcessLookupError(error, os.strerror(error), pid)
        raise CapabilityError("process identity could not be established for pid " + str(pid))
    raw = buffer.raw
    unique_id = struct.unpack_from("=Q", raw, 16)[0]
    pid_version = struct.unpack_from("=i", raw, 32)[0]
    if unique_id <= 0 or pid_version <= 0:
        raise CapabilityError("process identity is incomplete for pid " + str(pid))
    return unique_id, pid_version


def process_start(pid):
    proc_pidinfo, _, _ = _apis()
    buffer = ctypes.create_string_buffer(BSD_INFO_SIZE)
    ctypes.set_errno(0)
    result = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, buffer, BSD_INFO_SIZE)
    if result != BSD_INFO_SIZE:
        error = ctypes.get_errno()
        if result in (-1, 0) and error == errno.ESRCH:
            raise ProcessLookupError(error, os.strerror(error), pid)
        raise CapabilityError("process start time could not be established for pid " + str(pid))
    raw = buffer.raw
    reported_pid = struct.unpack_from("=I", raw, BSD_PID_OFFSET)[0]
    seconds = struct.unpack_from("=Q", raw, BSD_START_SECONDS_OFFSET)[0]
    microseconds = struct.unpack_from("=Q", raw, BSD_START_MICROSECONDS_OFFSET)[0]
    if reported_pid != pid or seconds <= 0 or microseconds >= 1000000:
        raise CapabilityError("process start identity is incomplete for pid " + str(pid))
    return seconds, microseconds


def coalition_id(pid):
    proc_pidinfo, _, _ = _apis()
    values = (ctypes.c_uint64 * 5)()
    ctypes.set_errno(0)
    result = proc_pidinfo(pid, PROC_PIDCOALITIONINFO, 0, values, COALITION_SIZE)
    if result != COALITION_SIZE:
        error = ctypes.get_errno()
        if result in (-1, 0) and error == errno.ESRCH:
            raise ProcessLookupError(error, os.strerror(error), pid)
        raise CapabilityError("resource coalition could not be established for pid " + str(pid))
    value = int(values[RESOURCE_COALITION_INDEX])
    if value <= 0:
        raise CapabilityError("process has no verifiable resource coalition")
    return value


def joined_identity(pid):
    before = (process_identity(pid), process_start(pid))
    resource_id = coalition_id(pid)
    after = (process_identity(pid), process_start(pid))
    if before != after:
        raise CapabilityError("process identity changed while joining its coalition")
    return {
        "pid": pid, "unique_id": before[0][0], "pid_version": before[0][1],
        "start_sec": before[1][0], "start_usec": before[1][1],
        "coalition_id": resource_id,
    }


def identity_if_present(pid):
    try:
        return joined_identity(pid)
    except ProcessLookupError as error:
        if error.errno != errno.ESRCH:
            raise
        return None


def same_process(expected, actual):
    keys = ("pid", "unique_id", "pid_version", "start_sec", "start_usec", "coalition_id")
    return (isinstance(expected, dict) and isinstance(actual, dict)
            and all(key in expected and key in actual for key in keys)
            and all(expected[key] == actual[key] for key in keys))


def task_counts(resource_id):
    _, coalition_info, _ = _apis()
    buffer = ctypes.create_string_buffer(RESOURCE_USAGE_SIZE)
    ctypes.set_errno(0)
    result = coalition_info(resource_id, buffer, RESOURCE_USAGE_SIZE)
    if result != 0:
        error = ctypes.get_errno()
        if result == -1 and error == errno.ESRCH:
            raise CoalitionGone("resource coalition has been reaped")
        raise CapabilityError("resource-coalition task counters are unavailable: " + str(result))
    started, exited = struct.unpack_from("=QQ", buffer.raw)
    if started < exited:
        raise CapabilityError("resource-coalition task counters are inconsistent")
    return started, exited


def _coalition_members(resource_id, timeout, excluded=()):
    result = subprocess.run(
        ["ps", "-A", "-o", "pid="], capture_output=True, text=True,
        check=False, timeout=max(0.01, timeout), env={**os.environ, "LC_ALL": "C"},
    )
    if result.returncode != 0:
        raise CapabilityError("process enumeration failed during coalition cleanup")
    members = []
    for field in result.stdout.split():
        if not field.isdecimal():
            raise CapabilityError("process enumeration returned an invalid PID")
        pid = int(field)
        if pid <= 1 or pid == os.getpid() or pid in excluded:
            continue
        try:
            identity = identity_if_present(pid)
        except CapabilityError:
            continue
        if identity is not None and identity["coalition_id"] == resource_id:
            members.append(identity)
    return members


def _signal(identity, signal_number):
    _, _, signal_with_token = _apis()
    current = identity_if_present(identity["pid"])
    if current is None or not same_process(identity, current):
        return False
    token = (ctypes.c_uint32 * 8)()
    token[5] = identity["pid"]
    token[7] = identity["pid_version"]
    result = signal_with_token(ctypes.byref(token), signal_number)
    if result == 0:
        return True
    try:
        current = identity_if_present(identity["pid"])
    except CapabilityError:
        return False
    if current is None:
        return False
    if same_process(identity, current):
        raise CapabilityError("identity-safe signal failed for an owned coalition process: " + str(result))
    return False


def signal_identity(identity, signal_number):
    return _signal(identity, signal_number)


def _signal_members(resource_id, signal_number, deadline, excluded=()):
    members = _coalition_members(resource_id, deadline - time.monotonic(), excluded)
    for identity in members:
        _signal(identity, signal_number)


def _drained(resource_id, preserve, allow_reaped):
    try:
        started, exited = task_counts(resource_id)
    except CoalitionGone:
        if allow_reaped:
            return True
        raise
    active = started - exited
    if active == 0:
        return True
    if active != 1 or preserve is None:
        return False
    try:
        actual = identity_if_present(preserve["pid"])
    except CapabilityError:
        return False
    return actual is not None and same_process(preserve, actual) and actual["coalition_id"] == resource_id


def drain(resource_id, deadline, preserve=None, allow_reaped=False):
    term_deadline = min(deadline, time.monotonic() + TERM_SECONDS)
    while time.monotonic() < term_deadline:
        if _drained(resource_id, preserve, allow_reaped):
            return True
        excluded = (preserve["pid"],) if preserve else ()
        _signal_members(resource_id, signal.SIGTERM, deadline, excluded)
        time.sleep(min(POLL_SECONDS, max(0, term_deadline - time.monotonic())))

    while time.monotonic() < deadline:
        if _drained(resource_id, preserve, allow_reaped):
            return True
        excluded = (preserve["pid"],) if preserve else ()
        _signal_members(resource_id, signal.SIGKILL, deadline, excluded)
        time.sleep(min(POLL_SECONDS, max(0, deadline - time.monotonic())))
    return _drained(resource_id, preserve, allow_reaped)
