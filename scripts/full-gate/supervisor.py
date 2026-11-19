import ctypes
import hashlib
import json
import importlib.util
import os
import plistlib
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


SUPERVISOR_ENVIRONMENT = "DISCORD_SURFACE_GATE_SUPERVISOR"
LINUX_SUBREAPER = "linux-subreaper-v1"
DARWIN_LAUNCHD = "darwin-launchd-v1"
_DARWIN_OWNER = None
_REAPING_OWNER = None
SUPERVISOR_RECEIPT_ENVIRONMENT = "DISCORD_SURFACE_GATE_SUPERVISOR_RECEIPT"
SUPERVISOR_TOKEN_ENVIRONMENT = "DISCORD_SURFACE_GATE_SUPERVISOR_TOKEN"
NO_VERDICT = 98
CLEANUP_RESERVE_SECONDS = 5
TERMINATION_GRACE_SECONDS = 1
SNAPSHOT_STOP_RESERVE_SECONDS = 2
POLL_SECONDS = 0.025
GATE_MODULE = Path(__file__).resolve().parents[2] / "scripts" / "full-gate.js"
# Exit 4 is only the gate's own budget refusal. Any other snapshot failure is source or Git
# infrastructure, which capture_snapshot raises as OSError so every caller reports no verdict.
SNAPSHOT_PROGRAM = (
    "const gate = require(" + json.dumps(str(GATE_MODULE)) + ");"
    "try { process.stdout.write(gate.supervisorSnapshot(process.cwd(), "
    "process.argv[1])); } catch (error) {"
    "process.stderr.write(error.message + '\\n'); process.exitCode = 1;"
    "if (error.code === 'ETIMEDOUT') process.exitCode = 98;"
    "else if (/^APERTURE_GATE_(?:TIME_LEFT_S|SLOWEST_RUN_S) must be a positive whole number$/.test(error.message))"
    " process.exitCode = 4; }"
)


_LINUX_GENERIC_SIGACTION_ABI_LIBCS = frozenset({"glibc", "musl"})
_LINUX_SIGACTION_ABI_LIBCS = {
    "x86_64": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "amd64": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "i386": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "i486": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "i586": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "i686": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "aarch64": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "armv6l": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "armv7l": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "armv8l": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "ppc64le": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "s390x": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
    "loongarch64": _LINUX_GENERIC_SIGACTION_ABI_LIBCS,
}
_LINUX_SIGSET_SIZE = 128
_LINUX_SA_NOCLDWAIT = 0x2


def _linux_libc_family():
    try:
        version = os.confstr("CS_GNU_LIBC_VERSION")
    except (AttributeError, OSError, ValueError):
        version = None
    if isinstance(version, str) and version.startswith("glibc "):
        return "glibc"

    try:
        with open("/proc/self/maps", encoding="ascii") as mappings:
            mapped_libraries = mappings.read()
    except (OSError, UnicodeError) as error:
        raise OSError("Linux C library ABI could not be verified") from error

    has_musl = "ld-musl-" in mapped_libraries
    has_glibc = "libc.so.6" in mapped_libraries or "/libc-" in mapped_libraries
    if has_musl == has_glibc:
        return None
    return "musl" if has_musl else "glibc"


def _linux_sigaction_abi(machine=None, libc=None):
    if machine is None:
        try:
            machine = os.uname().machine
        except (AttributeError, OSError) as error:
            raise OSError("Linux machine ABI could not be verified") from error
    if not isinstance(machine, str) or not machine:
        raise OSError("Linux machine ABI could not be verified")
    machine = machine.lower()
    supported_libcs = _LINUX_SIGACTION_ABI_LIBCS.get(machine)
    if supported_libcs is None:
        raise OSError("Linux SIGCHLD ABI is unsupported")

    if libc is None:
        libc = _linux_libc_family()
    if not isinstance(libc, str) or libc.lower() not in supported_libcs:
        raise OSError("Linux SIGCHLD ABI is unsupported")
    return _LINUX_SIGSET_SIZE, _LINUX_SA_NOCLDWAIT


class InvalidGateBudget(Exception):
    pass


class SnapshotCleanupError(OSError):
    pass


class JobRequestCancelled(InterruptedError):
    pass


def _native_sigchld_flags():
    if sys.platform == "darwin":
        class NativeSigaction(ctypes.Structure):
            _fields_ = [
                ("sa_handler", ctypes.c_void_p),
                ("sa_mask", ctypes.c_uint32),
                ("sa_flags", ctypes.c_int),
            ]

        no_cldwait = 0x20
    elif sys.platform == "linux":
        mask_size, no_cldwait = _linux_sigaction_abi()
        mask_type = ctypes.c_ubyte * mask_size

        class NativeSigaction(ctypes.Structure):
            _fields_ = [
                ("sa_handler", ctypes.c_void_p),
                ("sa_mask", mask_type),
                ("sa_flags", ctypes.c_int),
                ("sa_restorer", ctypes.c_void_p),
            ]
    else:
        raise OSError("waitable child status is unsupported on this platform")
    action = NativeSigaction()
    try:
        native_sigaction = ctypes.CDLL(None, use_errno=True).sigaction
    except AttributeError as error:
        raise OSError("native SIGCHLD action inspection is unavailable") from error
    native_sigaction.argtypes = (ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
    native_sigaction.restype = ctypes.c_int
    if native_sigaction(signal.SIGCHLD, None, ctypes.byref(action)) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    return action.sa_flags, no_cldwait


def establish_reaping_contract():
    global _REAPING_OWNER
    owner = (os.getpid(), threading.get_ident())
    if threading.active_count() != 1:
        raise OSError("exclusive child reaping cannot be established with multiple threads")
    if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
        raise OSError("SIGCHLD disposition does not preserve waitable children")
    flags, no_cldwait = _native_sigchld_flags()
    if flags & no_cldwait:
        raise OSError("SA_NOCLDWAIT prevents owned child reaping")
    if _REAPING_OWNER is not None and _REAPING_OWNER != owner:
        raise OSError("child reaping ownership changed after setup")
    _REAPING_OWNER = owner


def _write_job_output(descriptor, payload, deadline=None, logical_state=None, interrupted=None):
    offset = 0
    state = logical_state if logical_state is not None else {}
    attempted = bool(state.get("attempted"))
    while offset < len(payload):
        if interrupted is not None and interrupted.is_set():
            break
        if attempted and deadline is not None:
            try:
                if not clock_now() < deadline:
                    break
            except OSError:
                break
        attempted = True
        state["attempted"] = True
        written = 0
        was_blocking = None
        try:
            was_blocking = os.get_blocking(descriptor)
            os.set_blocking(descriptor, False)
            written = os.write(descriptor, payload[offset:offset + 64 * 1024])
        except (BlockingIOError, BrokenPipeError, OSError):
            pass
        finally:
            if was_blocking is not None:
                try:
                    os.set_blocking(descriptor, was_blocking)
                except OSError:
                    pass
        offset += written
        if interrupted is not None and interrupted.is_set():
            break
        if deadline is None or offset == len(payload):
            break
        try:
            remaining = deadline - clock_now()
        except OSError:
            break
        if not remaining > 0:
            break
        if not written:
            time.sleep(min(POLL_SECONDS, remaining))
    return offset


_TERMINAL_MARKER = b"APERTURE-GATE-INDETERMINATE reason="
_OUTPUT_CHUNK_SIZE = 64 * 1024
_ACTIVE_TERMINAL_OUTPUT = None


def split_terminal_output(payload, result):
    if result != NO_VERDICT:
        return payload, None, True
    ordinary = []
    candidate = None
    for line in payload.splitlines(keepends=True):
        if not line.startswith(_TERMINAL_MARKER):
            ordinary.append(line)
            continue
        if not line.endswith(b"\n"):
            return b"".join(ordinary), candidate, False
        if candidate is None:
            candidate = line
    return b"".join(ordinary), candidate, True


def _join_detail(*details):
    result = None
    for detail in details:
        if not detail:
            continue
        detail = str(detail)
        if result is None:
            result = detail
        elif detail not in result:
            result += "; " + detail
    return result


def select_terminal_outcome(result, reason, detail, output_complete, retirement_complete, candidate,
                            output_failure=None, retirement_failure=None):
    if not retirement_complete:
        return NO_VERDICT, "cleanup", _join_detail(
            detail, "prior reason=" + reason if reason and reason != "cleanup" else None,
            retirement_failure or "gate cleanup custody is incomplete", output_failure
        ), None
    if reason is not None:
        return NO_VERDICT, reason, _join_detail(detail or reason, output_failure), None
    if not output_complete:
        return NO_VERDICT, "cleanup", _join_detail(
            detail, output_failure or "gate output custody is incomplete"
        ), None
    if result == NO_VERDICT and candidate is not None:
        return NO_VERDICT, None, None, candidate
    return result, None, None, None


class TerminalOutput:
    def __init__(self):
        self.outputs = []
        self.capture_handles = []
        self.accepted_offsets = {}
        self.reason = None
        self.detail = None
        self.candidate = None
        self.deadline = None
        self.cursor = None
        self.output_complete = True
        self.retirement_complete = True
        self.output_failure = None
        self.retirement_failure = None
        self.marker_attempted = False
        self.recovery_path = None
        self.recovery_prepared = None
        self.recovery_staged = False
        self.verdict_journal_path = None
        self.verdict_range_count = 0
        self.verdict_range_end = None

    @property
    def evidence_paths(self):
        paths = []
        for output in self.outputs:
            paths.append(output["path"])
            render_path = output.get("render_path")
            if render_path is not None:
                paths.append(render_path)
        if self.recovery_path is not None:
            paths.append(self.recovery_path)
        if self.verdict_journal_path is not None:
            paths.append(self.verdict_journal_path)
        return paths

    def prepare_recovery(self):
        if self.recovery_prepared is not None:
            return self.recovery_prepared
        self.recovery_prepared = False
        descriptor = None
        try:
            descriptor, self.recovery_path = tempfile.mkstemp(prefix="dsg-recovery-")
            selected = descriptor
            descriptor = None
            os.close(selected)
            self.recovery_prepared = True
            return True
        except OSError as error:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            self.fail_output("gate recovery custody could not be created: " + str(error))
            return False

    def stage_recovery(self, payload):
        self.recovery_staged = False
        if not self.prepare_recovery():
            return False
        descriptor = None
        record = None
        try:
            descriptor, path = tempfile.mkstemp(prefix="dsg-recovery-", dir=os.path.dirname(self.recovery_path))
            record = {"name": "recovery", "path": path, "replay": False, "candidate": False}
            self.outputs.append(record)
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = None
                written = handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
                if written != len(payload):
                    raise OSError("gate recovery custody was incomplete")
            os.replace(path, self.recovery_path)
            self.outputs.remove(record)
            self.recovery_staged = True
            return True
        except OSError as error:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            self.fail_output("gate recovery custody could not be staged: " + str(error))
            return False

    def set_deadline(self, deadline):
        if deadline is None:
            return
        self.deadline = deadline if self.deadline is None else min(self.deadline, deadline)

    def request(self, reason, detail, *, stdout_cursor=None, stdout_deadline=None):
        if stdout_cursor is not None:
            self.cursor = stdout_cursor
        self.set_deadline(stdout_deadline)
        if reason is None:
            return
        if self.reason is None:
            self.reason, self.detail = reason, detail
        elif self.reason == reason:
            self.detail = _join_detail(self.detail, detail)

    def fail_output(self, detail):
        self.output_complete = False
        self.output_failure = _join_detail(self.output_failure, detail)

    def fail_retirement(self, detail):
        self.retirement_complete = False
        self.retirement_failure = _join_detail(self.retirement_failure, detail)

    def add_capture(self, name, *, replay=True):
        handle = tempfile.NamedTemporaryFile(mode="w+b", prefix="dsg-output-", delete=False)
        self.outputs.append({"name": name, "path": handle.name, "replay": replay, "candidate": False})
        self.capture_handles.append(handle)
        return handle

    def close_captures(self):
        complete = True
        for handle in self.capture_handles:
            if handle.closed:
                continue
            try:
                handle.close()
            except OSError as error:
                complete = False
                self.fail_output("gate output capture close failed: " + str(error))
        self.capture_handles.clear()
        return complete

    def add_payload(self, name, payload, *, replay, candidate=False):
        descriptor = None
        path = None
        try:
            descriptor, path = tempfile.mkstemp(prefix="dsg-output-")
            record = {"name": name, "path": path, "replay": replay, "candidate": candidate}
            self.outputs.append(record)
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = None
                written = handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
                if written != len(payload):
                    raise OSError("private gate output staging was incomplete")
            return True
        except OSError as error:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            self.fail_output("gate output could not be staged: " + str(error))
            return False

    def _deadline_available(self):
        if self.deadline is None:
            return True
        try:
            return clock_now() < self.deadline
        except OSError:
            return False

    def _copy_range_to_handle(self, source, start, end, destination):
        size = os.stat(source).st_size
        if end is None:
            end = size
        if not 0 <= start <= end <= size:
            raise OSError("gate output range was invalid")
        remaining = end - start
        with open(source, "rb") as handle:
            handle.seek(start)
            while remaining:
                if not self._deadline_available():
                    raise OSError("gate output range copy exceeded the caller deadline")
                payload = handle.read(min(_OUTPUT_CHUNK_SIZE, remaining))
                if not payload:
                    raise OSError("gate output range copy was short")
                written = destination.write(payload)
                if written != len(payload):
                    raise OSError("gate output range copy was incomplete")
                remaining -= written
        destination.flush()
        os.fsync(destination.fileno())
        return end

    def add_file_range(self, name, source, start=0, end=None, *, replay, candidate=False):
        descriptor = None
        path = None
        record = None
        try:
            descriptor, path = tempfile.mkstemp(prefix="dsg-output-")
            record = {
                "name": name,
                "path": path,
                "replay": replay,
                "candidate": candidate,
                "source": source,
                "source_start": start,
                "source_end": end,
            }
            self.outputs.append(record)
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = None
                copied_end = self._copy_range_to_handle(source, start, end, handle)
            record["size"] = copied_end - start
            return True
        except (OSError, ValueError) as error:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            self.fail_output("gate output range could not be staged: " + str(error))
            return False

    def record_verdict_range(self, start, end):
        if not self.output_complete:
            return False
        if (type(start) is not int or type(end) is not int or start < 0
                or end <= start or end >= 1 << 64
                or self.verdict_range_end is not None and start < self.verdict_range_end):
            self.fail_output("gate verdict range was invalid")
            return False
        payload = start.to_bytes(8, "big") + end.to_bytes(8, "big")
        descriptor = None
        try:
            if self.verdict_journal_path is None:
                descriptor, self.verdict_journal_path = tempfile.mkstemp(prefix="dsg-verdict-")
            else:
                descriptor = os.open(self.verdict_journal_path, os.O_WRONLY | os.O_APPEND)
            written = os.write(descriptor, payload)
            if written != len(payload):
                raise OSError("gate verdict journal append was incomplete")
            selected = descriptor
            descriptor = None
            os.close(selected)
            self.verdict_range_count += 1
            self.verdict_range_end = end
            return True
        except (OSError, ValueError) as error:
            self.fail_output("gate verdict range could not be journaled: " + str(error))
            return False
        finally:
            if descriptor is not None:
                selected = descriptor
                descriptor = None
                try:
                    os.close(selected)
                except OSError as error:
                    self.fail_output("gate verdict journal close failed: " + str(error))

    def stage_verdict_ranges(self, source):
        if not self.output_complete:
            return False
        if self.verdict_journal_path is None or self.verdict_range_count == 0:
            self.fail_output("required gate verdict ranges have no journal")
            return False
        descriptor = None
        record = None
        try:
            descriptor, path = tempfile.mkstemp(prefix="dsg-output-")
            record = {
                "name": "stdout",
                "path": path,
                "replay": True,
                "candidate": False,
                "range_count": self.verdict_range_count,
            }
            self.outputs.append(record)
            with os.fdopen(descriptor, "wb") as destination:
                descriptor = None
                source_size = os.stat(source).st_size
                previous_end = 0
                staged_count = 0
                with open(source, "rb") as source_handle, open(self.verdict_journal_path, "rb") as journal:
                    while True:
                        encoded = journal.read(16)
                        if not encoded:
                            break
                        if len(encoded) != 16:
                            raise OSError("gate verdict journal record was incomplete")
                        start = int.from_bytes(encoded[:8], "big")
                        end = int.from_bytes(encoded[8:], "big")
                        if not previous_end <= start < end <= source_size:
                            raise OSError("gate verdict journal range was invalid")
                        source_handle.seek(start)
                        marker = source_handle.read(len(_TERMINAL_MARKER))
                        source_handle.seek(end - 1)
                        newline = source_handle.read(1)
                        if marker != _TERMINAL_MARKER or newline != b"\n":
                            raise OSError("saved gate verdict marker was incomplete")
                        source_handle.seek(start)
                        remaining = end - start
                        while remaining:
                            if not self._deadline_available():
                                raise OSError("gate verdict range stage exceeded the caller deadline")
                            payload = source_handle.read(min(_OUTPUT_CHUNK_SIZE, remaining))
                            if not payload:
                                raise OSError("gate verdict range stage was short")
                            written = destination.write(payload)
                            if written != len(payload):
                                raise OSError("gate verdict range stage was incomplete")
                            remaining -= written
                        previous_end = end
                        staged_count += 1
                if staged_count != self.verdict_range_count:
                    raise OSError("gate verdict journal record count changed")
                destination.flush()
                os.fsync(destination.fileno())
            record["size"] = os.stat(path).st_size
            return True
        except (OSError, ValueError) as error:
            if descriptor is not None:
                selected = descriptor
                descriptor = None
                try:
                    os.close(selected)
                except OSError:
                    pass
            self.fail_output("gate verdict ranges could not be staged: " + str(error))
            return False

    def add_file(self, name, source, *, replay, candidate=False):
        return self.add_file_range(name, source, 0, None, replay=replay, candidate=candidate)

    def _marker_range_valid(self, path, start, end):
        try:
            size = os.stat(path).st_size
            if not 0 <= start < end <= size or end - start < len(_TERMINAL_MARKER) + 1:
                raise OSError("saved gate verdict marker was incomplete")
            with open(path, "rb") as handle:
                handle.seek(start)
                if handle.read(len(_TERMINAL_MARKER)) != _TERMINAL_MARKER:
                    raise OSError("saved gate verdict marker was incomplete")
                handle.seek(end - 1)
                if handle.read(1) != b"\n":
                    raise OSError("saved gate verdict marker was incomplete")
            return True
        except OSError as error:
            self.fail_output(str(error))
            return False

    def _candidate_range(self, output):
        path = output["path"]
        try:
            size = os.stat(path).st_size
        except OSError as error:
            self.fail_output("required gate candidate could not be inspected: " + str(error))
            return None
        if not self._marker_range_valid(path, 0, size):
            return None
        return {"path": path, "start": 0, "end": size}

    def _scan_record(self, output, result):
        path = output["path"]
        if output["candidate"]:
            return self._candidate_range(output)
        try:
            size = os.stat(path).st_size
        except OSError as error:
            self.fail_output("required gate output could not be inspected: " + str(error))
            return None
        if result != NO_VERDICT:
            output["publish_path"] = path
            output["publish_start"] = 0
            output["publish_end"] = size
            return None

        render_descriptor = None
        render_path = None
        render = None
        if output["replay"]:
            try:
                render_descriptor, render_path = tempfile.mkstemp(prefix="dsg-render-")
                render = os.fdopen(render_descriptor, "wb")
                render_descriptor = None
                output["render_path"] = render_path
            except OSError as error:
                if render_descriptor is not None:
                    try:
                        os.close(render_descriptor)
                    except OSError:
                        pass
                self.fail_output("gate output render could not be created: " + str(error))
                return None

        ordinary = bytearray()
        probe = bytearray()
        candidate = None
        in_marker = False
        marker_start = None
        line_start = True
        offset = 0
        try:
            with open(path, "rb") as handle:
                while True:
                    if not self._deadline_available():
                        raise OSError("gate output scan exceeded the caller deadline")
                    payload = handle.read(_OUTPUT_CHUNK_SIZE)
                    if not payload:
                        break
                    for value in payload:
                        if in_marker:
                            if value == 10:
                                if candidate is None:
                                    candidate = {"path": path, "start": marker_start, "end": offset + 1}
                                in_marker = False
                                marker_start = None
                                line_start = True
                            offset += 1
                            continue
                        if probe:
                            if value == _TERMINAL_MARKER[len(probe)]:
                                probe.append(value)
                                offset += 1
                                if len(probe) == len(_TERMINAL_MARKER):
                                    in_marker = True
                                    marker_start = offset - len(_TERMINAL_MARKER)
                                    probe.clear()
                                continue
                            ordinary.extend(probe)
                            probe.clear()
                            line_start = False
                        if line_start and value == _TERMINAL_MARKER[0]:
                            probe.append(value)
                        else:
                            ordinary.append(value)
                            line_start = value == 10
                        offset += 1
                        if len(ordinary) >= _OUTPUT_CHUNK_SIZE:
                            if render is not None:
                                written = render.write(ordinary)
                                if written != len(ordinary):
                                    raise OSError("gate output render was incomplete")
                            ordinary.clear()
                if in_marker:
                    raise OSError("required gate output ended inside a verdict marker")
                if probe:
                    ordinary.extend(probe)
                if ordinary and render is not None:
                    written = render.write(ordinary)
                    if written != len(ordinary):
                        raise OSError("gate output render was incomplete")
            if render is not None:
                render.flush()
                os.fsync(render.fileno())
                render.close()
                render = None
                output["publish_path"] = render_path
                output["publish_start"] = 0
                output["publish_end"] = os.stat(render_path).st_size
            else:
                output["publish_path"] = None
            return candidate
        except (OSError, ValueError) as error:
            if render is not None:
                try:
                    render.close()
                except OSError:
                    pass
            self.fail_output(str(error))
            return None

    def _relay_range(self, descriptor, source, start, end, prefix=b""):
        state = {"attempted": False}
        written_total = 0
        first = True
        last = None
        try:
            with open(source, "rb") as handle:
                handle.seek(start)
                remaining = end - start
                while remaining:
                    if state["attempted"] and not self._deadline_available():
                        return written_total, False, last
                    chunk_limit = _OUTPUT_CHUNK_SIZE - (len(prefix) if first else 0)
                    payload = handle.read(min(chunk_limit, remaining))
                    if not payload:
                        return written_total, False, last
                    wire = prefix + payload if first and prefix else payload
                    written = _write_job_output(descriptor, wire, self.deadline, state)
                    state["attempted"] = True
                    written_total += written
                    if written:
                        last = wire[written - 1]
                    if written != len(wire):
                        return written_total, False, last
                    remaining -= len(payload)
                    first = False
            return written_total, True, last
        except (OSError, ValueError):
            return written_total, False, last

    def stage_recovery_range(self, source, start, end):
        self.recovery_staged = False
        if not self.prepare_recovery():
            return False
        descriptor = None
        path = None
        record = None
        try:
            descriptor, path = tempfile.mkstemp(prefix="dsg-recovery-", dir=os.path.dirname(self.recovery_path))
            record = {"name": "recovery", "path": path, "replay": False, "candidate": False}
            self.outputs.append(record)
            with os.fdopen(descriptor, "wb") as handle:
                descriptor = None
                self._copy_range_to_handle(source, start, end, handle)
            os.replace(path, self.recovery_path)
            self.outputs.remove(record)
            self.recovery_staged = True
            return True
        except (OSError, ValueError) as error:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            self.fail_output("gate recovery range could not be staged: " + str(error))
            return False

    def _failure_detail(self, detail):
        detail = detail or "gate output custody is incomplete"
        if self.evidence_paths:
            detail += "; output evidence retained at " + ", ".join(self.evidence_paths)
        return detail

    def publish(self, result):
        self.prepare_recovery()
        if self.cursor is not None and self.cursor.get("retain_output"):
            self.fail_output("required gate output remains under retained custody")
        candidate = None
        pending = None
        if self.output_complete:
            for output in self.outputs:
                if output.get("pending_marker"):
                    pending = output
                    continue
                if not output["replay"] and not output["candidate"]:
                    continue
                found = self._scan_record(output, result)
                if candidate is None and found is not None:
                    candidate = found
                if not self.output_complete:
                    break
        candidate = self.candidate or candidate
        retained = None
        if pending is not None:
            if self.reason is not None:
                retained = pending["path"]
            elif self.output_complete and self.retirement_complete and (result != NO_VERDICT or candidate is None):
                pending.update(replay=True, publish_path=pending["path"], publish_start=0, publish_end=pending["size"])

        output_line_start = self.cursor.get("output_line_start", True) if self.cursor is not None else True
        if self.output_complete:
            for output in self.outputs:
                path = output.get("publish_path")
                if not output["replay"] or path is None:
                    continue
                name = output["name"]
                descriptor = sys.stderr.fileno() if name == "stderr" else sys.stdout.fileno()
                written, delivered, last = self._relay_range(
                    descriptor, path, output["publish_start"], output["publish_end"]
                )
                self.accepted_offsets[name] = written
                if name == "stdout" and last is not None:
                    output_line_start = last == 10
                if output.get("pending_marker") and self.cursor is not None:
                    self.cursor["offset"] = output["source_start"] + written
                    if last is not None:
                        self.cursor["source_line_start"] = self.cursor["output_line_start"] = last == 10
                    if delivered:
                        self.cursor["pending_marker"] = None
                        self.cursor.pop("pending_marker_end", None)
                    else:
                        self.cursor["retain_output"] = True
                if not delivered:
                    self.fail_output("final " + name + " relay was incomplete")
                    break

        def selected_record():
            code, reason, detail, selected_candidate = select_terminal_outcome(
                result, self.reason, self.detail, self.output_complete, self.retirement_complete, candidate,
                output_failure=self.output_failure, retirement_failure=self.retirement_failure
            )
            if reason is not None:
                if not self.output_complete or not self.retirement_complete:
                    detail = self._failure_detail(detail)
                elif retained is not None:
                    detail = _join_detail(detail, "incomplete gate marker retained at " + retained)
                marker = ("APERTURE-GATE-INDETERMINATE reason=" + reason + ": " + str(detail or reason) + "\n").encode(
                    "utf-8", errors="replace"
                )
                return code, marker
            return code, selected_candidate

        code, marker = selected_record()
        if isinstance(marker, dict):
            if not self.stage_recovery_range(marker["path"], marker["start"], marker["end"]):
                code, marker = selected_record()
        elif marker is not None and not self.stage_recovery(marker):
            code, marker = selected_record()
        if marker is not None and not self.marker_attempted:
            self.marker_attempted = True
            prefix = b"" if output_line_start else b"\n"
            if isinstance(marker, dict):
                written, delivered, _ = self._relay_range(
                    sys.stdout.fileno(), marker["path"], marker["start"], marker["end"], prefix=prefix
                )
            else:
                wire = prefix + marker if prefix else marker
                state = {"attempted": False}
                try:
                    written = _write_job_output(sys.stdout.fileno(), wire, self.deadline, state)
                    delivered = written == len(wire)
                except (OSError, ValueError):
                    written = 0
                    delivered = False
            self.accepted_offsets["verdict"] = written
            if self.cursor is not None:
                self.cursor["verdict_delivery_complete"] = delivered
            if not delivered:
                self.output_complete = False
                self.output_failure = "final gate verdict delivery was incomplete"
                if self.cursor is not None:
                    self.cursor["retain_output"] = True
                return NO_VERDICT
        elif self.cursor is not None and marker is None:
            self.cursor["verdict_delivery_complete"] = True

        complete = self.output_complete and self.retirement_complete
        if self.cursor is not None:
            self.cursor["retain_output"] = self.cursor.get("retain_output", False) or not complete
        if complete:
            for path in self.evidence_paths:
                if path == retained:
                    continue
                try:
                    os.unlink(path)
                except OSError:
                    pass
        return code


def no_verdict(reason, detail, *, stdout_cursor=None, stdout_deadline=None):
    terminal = _ACTIVE_TERMINAL_OUTPUT
    if terminal is not None:
        terminal.request(
            reason, detail, stdout_cursor=stdout_cursor, stdout_deadline=stdout_deadline
        )
        return NO_VERDICT
    prefix = "\n" if stdout_cursor and not stdout_cursor["output_line_start"] else ""
    line = prefix + "APERTURE-GATE-INDETERMINATE reason=" + reason + ": " + detail + "\n"
    try:
        payload = line.encode("utf-8", errors="replace")
        delivered = _write_job_output(sys.stdout.fileno(), payload, stdout_deadline) == len(payload)
        if stdout_cursor is not None:
            stdout_cursor["verdict_delivery_complete"] = delivered
            stdout_cursor["retain_output"] = stdout_cursor.get("retain_output", False) or not delivered
    except (OSError, ValueError):
        pass
    return NO_VERDICT


def enable_subreaper():
    if sys.platform != "linux":
        raise OSError("kernel-backed descendant ownership is unavailable on this host")
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise OSError("pidfd signaling is unavailable on this host")
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = libc.prctl
    prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    prctl.restype = ctypes.c_int
    # The kernel reparents orphaned fork descendants to this supervisor.
    if prctl(36, 1, 0, 0, 0) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    descriptor = os.pidfd_open(os.getpid())
    try:
        signal.pidfd_send_signal(descriptor, 0)
    finally:
        os.close(descriptor)
    child_list().read_text(encoding="ascii")


def child_list():
    pid = os.getpid()
    return Path("/proc") / str(pid) / "task" / str(pid) / "children"


def direct_children():
    return [int(value) for value in child_list().read_text(encoding="ascii").split()]


def live_owned_children(excluded=(), deadline=None):
    excluded = set(excluded)
    while True:
        if deadline is not None and clock_now() >= deadline:
            return None
        if not excluded:
            try:
                waited, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return []
            if waited:
                continue
            children = direct_children()
            return children if children else None

        live = []
        reaped = False
        for pid in direct_children():
            if pid in excluded:
                continue
            try:
                waited, _ = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                reaped = True
                continue
            if waited == 0:
                live.append(pid)
            else:
                reaped = True
        if live:
            return live
        if not reaped:
            return []


def signal_owned_child(pid, signal_number):
    try:
        waited, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return
    if waited == pid:
        return
    descriptor = os.pidfd_open(pid)
    try:
        signal.pidfd_send_signal(descriptor, signal_number)
    except ProcessLookupError:
        pass
    finally:
        os.close(descriptor)


def wait_for_owned_children(deadline):
    while True:
        children = live_owned_children(deadline=deadline)
        if children is None:
            return False
        if not children:
            return True
        remaining = deadline - clock_now()
        if remaining <= 0:
            return False
        time.sleep(min(POLL_SECONDS, remaining))


def signal_group(pgid, signal_number):
    # EPERM means the group remains but holds no live member, such as an exited leader not yet reaped.
    try:
        os.killpg(pgid, signal_number)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def wait_for_group_exit(process, deadline):
    # The group id names no group only once every member, exited ones included, has been reaped.
    while True:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            # An exiting leader stops taking signals a moment before it can be reaped. Probe again once it is.
            if process.returncode is None and process.poll() is not None:
                continue
        remaining = deadline - clock_now()
        if remaining <= 0:
            return False
        time.sleep(min(POLL_SECONDS, remaining))


def stop_owned_processes(process, deadline):
    try:
        establish_reaping_contract()
    except OSError:
        return False
    if sys.platform == "darwin":
        if process is None:
            return True
        if process.returncode is None:
            signal_group(process.pid, signal.SIGTERM)
            term_deadline = min(deadline, clock_now() + TERMINATION_GRACE_SECONDS)
            while True:
                now = clock_now()
                if not signal_group(process.pid, signal.SIGTERM if now < term_deadline else signal.SIGKILL):
                    break
                if now >= deadline:
                    return False
                time.sleep(min(POLL_SECONDS, max(0, deadline - now)))
        return wait_for_group_exit(process, min(deadline, clock_now() + TERMINATION_GRACE_SECONDS))
    if process is not None and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    term_deadline = min(deadline, clock_now() + TERMINATION_GRACE_SECONDS)
    while clock_now() < term_deadline:
        process_live = process is not None and process.poll() is None
        excluded = {process.pid} if process_live else set()
        children = live_owned_children(excluded, term_deadline)
        if children is None:
            break
        for pid in children:
            signal_owned_child(pid, signal.SIGTERM)
        if not process_live and not children:
            return True
        time.sleep(min(POLL_SECONDS, max(0, term_deadline - clock_now())))

    if process is not None and process.poll() is None:
        signal_owned_child(process.pid, signal.SIGKILL)
    while clock_now() < deadline:
        process_live = process is not None and process.poll() is None
        excluded = {process.pid} if process_live else set()
        children = live_owned_children(excluded, deadline)
        if children is None:
            return False
        for pid in children:
            signal_owned_child(pid, signal.SIGKILL)
        if not process_live and not children:
            return True
        time.sleep(min(POLL_SECONDS, max(0, deadline - clock_now())))
    children = live_owned_children(deadline=deadline)
    return not (process is not None and process.poll() is None) and children == []


def capture_snapshot(root, environment, phase, deadline, interrupted, *, stop_deadline):
    establish_reaping_contract()
    # Leave the stop TERM grace plus time to see KILL land before stop_deadline.
    window = min(deadline, stop_deadline - SNAPSHOT_STOP_RESERVE_SECONDS)
    if interrupted is not None and interrupted.is_set():
        raise InterruptedError("source verification interrupted")
    remaining = window - clock_now()
    if remaining <= 0:
        raise TimeoutError("source verification exceeded the gate deadline")
    process = subprocess.Popen(
        ["node", "-e", SNAPSHOT_PROGRAM, phase],
        cwd=str(root),
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    failure = None
    result = None
    try:
        while True:
            remaining = window - clock_now()
            if interrupted is not None and interrupted.is_set():
                raise InterruptedError("source verification interrupted")
            if remaining <= 0:
                raise TimeoutError("source verification exceeded the gate deadline")
            try:
                output, error = process.communicate(timeout=min(remaining, POLL_SECONDS))
                break
            except subprocess.TimeoutExpired:
                continue
        cleanup_deadline = min(window, clock_now() + CLEANUP_RESERVE_SECONDS)
        if sys.platform == "linux":
            drained = wait_for_owned_children(cleanup_deadline)
        else:
            drained = wait_for_group_exit(process, cleanup_deadline)
        if not drained:
            raise TimeoutError("source snapshot left live descendants")
        if process.returncode == 4:
            raise InvalidGateBudget(error.strip() or "gate budget is invalid")
        if process.returncode == NO_VERDICT:
            raise TimeoutError(error.strip() or "source verification exceeded the gate deadline")
        if process.returncode != 0:
            raise OSError(error.strip() or "source snapshot failed")
        result = json.loads(output)
    except BaseException as error:
        failure = error
    finally:
        cleanup_error = None
        if failure is not None:
            try:
                if not stop_owned_processes(process, stop_deadline):
                    raise OSError("bounded verifier stop did not establish completion")
                process.wait(timeout=0)
            except BaseException as error:
                cleanup_error = error
        for pipe in (process.stdout, process.stderr):
            if pipe is not None:
                try:
                    pipe.close()
                except BaseException as error:
                    cleanup_error = error
        if cleanup_error is not None:
            raise SnapshotCleanupError("source verifier cleanup uncertain for owned pid " + str(process.pid)) from cleanup_error
    if failure is not None:
        raise failure
    return result


class SupervisorReceipt:
    def __init__(self):
        self.directory = tempfile.TemporaryDirectory(prefix="dsg-")
        self.path = os.path.join(self.directory.name, "r")
        self.token = secrets.token_hex(32)
        descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            payload = (self.token + "\n").encode("ascii")
            if os.write(descriptor, payload) != len(payload):
                raise OSError("supervisor receipt write was incomplete")
        finally:
            os.close(descriptor)
        os.chmod(self.path, 0o600)

    def close(self):
        self.directory.cleanup()


def caller_budget(environment):
    raw = environment.get("APERTURE_GATE_TIME_LEFT_S", "7200")
    if not raw.isascii() or not raw.isdecimal() or int(raw) < 1:
        raise InvalidGateBudget("APERTURE_GATE_TIME_LEFT_S must be a positive whole number of seconds")
    return int(raw)


def run_supervised(root, command, environment, started, receipt, interrupted):
    environment.pop("NODE_OPTIONS", None)
    environment[SUPERVISOR_ENVIRONMENT] = LINUX_SUBREAPER
    environment[SUPERVISOR_RECEIPT_ENVIRONMENT] = receipt.path
    environment[SUPERVISOR_TOKEN_ENVIRONMENT] = receipt.token
    environment["DISCORD_SURFACE_GATE_SUPERVISOR_PID"] = str(os.getpid())
    try:
        budget = caller_budget(environment)
    except InvalidGateBudget as error:
        print(str(error), file=sys.stderr)
        return 4
    deadline = started + budget
    terminal = globals().get("_ACTIVE_TERMINAL_OUTPUT")
    if terminal is not None:
        terminal.set_deadline(deadline)
    preflight_deadline = deadline - CLEANUP_RESERVE_SECONDS
    if preflight_deadline <= clock_now():
        return no_verdict("capacity", "caller budget leaves no time for source verification and cleanup")
    try:
        before = capture_snapshot(root, environment, "before", preflight_deadline, interrupted, stop_deadline=deadline)
    except SnapshotCleanupError as error:
        return no_verdict("cleanup", str(error))
    except InvalidGateBudget as error:
        print(str(error), file=sys.stderr)
        return 4
    except InterruptedError as error:
        return no_verdict("interrupted", str(error))
    except TimeoutError as error:
        return no_verdict("timeout", str(error))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return no_verdict("setup", str(error))

    deadline = started + min(budget, before["budget"])
    remaining = int(deadline - clock_now() - CLEANUP_RESERVE_SECONDS)
    if remaining - before["slowest"] < 1:
        return no_verdict("capacity", "caller budget leaves no time for admission plus execution")
    environment["APERTURE_GATE_TIME_LEFT_S"] = str(remaining)

    terminal = globals().get("_ACTIVE_TERMINAL_OUTPUT")
    if terminal is None:
        raise OSError("terminal output owner is unavailable")
    terminal.set_deadline(deadline)
    stdout_cursor = {"offset": 0, "source_line_start": True, "output_line_start": True}
    terminal.request(None, None, stdout_cursor=stdout_cursor, stdout_deadline=deadline)
    stdout_capture = terminal.add_capture("stdout", replay=False)
    stderr_capture = terminal.add_capture("stderr", replay=False)
    process = None
    result = NO_VERDICT
    reason = None
    detail = None
    scratch = None
    process_started = False
    writers_drained = False
    output_staged = False

    def finish(code=None, *, failure=None, failure_detail=None):
        nonlocal scratch, output_staged
        if scratch is not None and process_started and not writers_drained:
            detail = "gate scratch retained because descendant drainage is unverified"
            terminal.fail_retirement(detail)
            terminal.fail_output("gate output remains live because descendant drainage is unverified")
            return no_verdict("cleanup", detail)
        if not output_staged:
            output_staged = True
            output_result = NO_VERDICT if failure is not None or reason is not None or (code is not None and code < 0) else result
            if not _emit_job_stderr(
                stderr_capture.name, stdout_capture.name, output_result, True, stdout_cursor, deadline
            ):
                terminal.fail_output("required gate output staging was incomplete after process exit")
                if failure is None and reason is None:
                    failure = "cleanup"
                    failure_detail = "required gate output staging was incomplete after process exit"
        if scratch is not None:
            if not clock_now() < deadline:
                detail = "gate scratch retirement exceeded the caller deadline; allocation retained"
                terminal.fail_retirement(detail)
                return no_verdict("cleanup", detail)
            try:
                shutil.rmtree(scratch)
            except OSError as error:
                detail = "gate scratch removal failed: " + str(error)
                terminal.fail_retirement(detail)
                return no_verdict("cleanup", detail)
            if not clock_now() < deadline or os.path.lexists(scratch):
                detail = "gate scratch removal did not complete before the caller deadline"
                terminal.fail_retirement(detail)
                return no_verdict("cleanup", detail)
            scratch = None
        if failure is not None:
            return no_verdict(failure, failure_detail or failure)
        if code is not None and code < 0:
            return no_verdict("interrupted", "full gate ended from signal " + str(-code))
        return code

    try:
        scratch = tempfile.mkdtemp(prefix="discord-gate-")
        os.chmod(scratch, 0o700)
        environment["DISCORD_SURFACE_GATE_SCRATCH"] = scratch
        process = subprocess.Popen(
            command, cwd=str(root), env=environment, start_new_session=True,
            stdout=stdout_capture, stderr=stderr_capture,
        )
        process_started = True
        run_deadline = deadline - CLEANUP_RESERVE_SECONDS
        while process.poll() is None:
            _stream_stdout(stdout_capture.name, stdout_cursor, deadline=run_deadline, interrupted=interrupted)
            if interrupted.is_set():
                reason, detail = "interrupted", "full gate was interrupted"
                break
            if clock_now() >= run_deadline:
                reason, detail = "timeout", "full gate exceeded the caller deadline"
                break
            time.sleep(min(POLL_SECONDS, max(0, run_deadline - clock_now())))
        if reason:
            writers_drained = stop_owned_processes(process, deadline)
            if not writers_drained:
                reason, detail = "cleanup", "supervised process tree did not stop before the caller deadline"
        else:
            result = process.wait()
            writers_drained = wait_for_owned_children(run_deadline)
            if not writers_drained:
                writers_drained = stop_owned_processes(None, deadline)
                reason, detail = "timeout", "full gate exceeded the caller deadline while descendants remained"

        if writers_drained:
            output_offset = stdout_cursor["offset"]
            while clock_now() < run_deadline and not interrupted.is_set():
                next_offset = _stream_stdout(
                    stdout_capture.name, stdout_cursor, final=True,
                    deadline=run_deadline, interrupted=interrupted,
                )
                if next_offset is None or interrupted.is_set():
                    break
                try:
                    output_size = os.stat(stdout_capture.name).st_size
                except OSError:
                    output_size = next_offset
                if next_offset == output_size and stdout_cursor.get("pending_marker") is None:
                    break
                if next_offset == output_offset:
                    time.sleep(min(POLL_SECONDS, max(0, run_deadline - clock_now())))
                output_offset = next_offset
            if stdout_cursor.get("pending_marker") is None:
                try:
                    stdout_size = os.stat(stdout_capture.name).st_size
                except OSError:
                    stdout_cursor["retain_output"] = True
                else:
                    if stdout_cursor["offset"] < stdout_size:
                        stdout_cursor["retain_output"] = True

        try:
            after = capture_snapshot(root, environment, "after", deadline, interrupted, stop_deadline=deadline)
        except SnapshotCleanupError as error:
            reason, detail = "cleanup", str(error)
        except InterruptedError as error:
            if reason is None:
                reason, detail = "interrupted", str(error)
        except InvalidGateBudget as error:
            if reason is None:
                reason, detail = "setup", str(error)
        except TimeoutError as error:
            if reason is None:
                reason, detail = "timeout", str(error)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            if reason is None:
                reason, detail = "stale", "unable to verify source after execution: " + str(error)
        else:
            if before["snapshot"] != after["snapshot"] and reason is None:
                reason, detail = "stale", "source changed during supervised gate execution"

        if reason:
            return finish(failure=reason, failure_detail=detail)
        return finish(code=result)
    except OSError as error:
        if process_started and not writers_drained:
            if process is not None and process.poll() is None:
                writers_drained = stop_owned_processes(process, deadline)
            else:
                writers_drained = wait_for_owned_children(deadline)
            if not writers_drained:
                return finish(failure="cleanup", failure_detail="supervised process tree did not stop before the caller deadline")
        try:
            capture_snapshot(root, environment, "after", deadline, interrupted, stop_deadline=deadline)
        except SnapshotCleanupError as snapshot_error:
            return finish(failure="cleanup", failure_detail=str(snapshot_error))
        except Exception:
            return finish(failure="stale", failure_detail="unable to verify source after setup failure")
        return finish(failure="setup", failure_detail="full gate command could not start: " + str(error))
    finally:
        terminal.close_captures()


def load_darwin_owner():
    global _DARWIN_OWNER
    if _DARWIN_OWNER is None:
        sys.dont_write_bytecode = True
        module_path = Path(__file__).resolve().with_name("darwin.py")
        spec = importlib.util.spec_from_file_location("full_gate_darwin", module_path)
        if spec is None or spec.loader is None:
            raise OSError("Darwin process-ownership helper could not load")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _DARWIN_OWNER = module
    return _DARWIN_OWNER


def clock_now():
    if sys.platform == "darwin":
        return load_darwin_owner().clock_now()
    return time.monotonic()


def _launchctl(launchctl, arguments, deadline):
    remaining = deadline - clock_now()
    if remaining <= 0:
        raise TimeoutError("launchd operation exceeded the caller deadline")
    try:
        return subprocess.run(
            [launchctl, *arguments], capture_output=True, text=True,
            check=False, timeout=remaining,
        )
    except subprocess.TimeoutExpired as error:
        raise TimeoutError("launchd operation exceeded the caller deadline") from error


def _service_state(launchctl, service, deadline):
    result = _launchctl(launchctl, ["print", service], deadline)
    output = result.stdout + result.stderr
    if result.returncode == 0:
        pid_match = re.search(r"(?m)^\s*pid = (\d+)\s*$", output)
        state_match = re.search(r"(?m)^\s*state = ([a-zA-Z_-]+(?: [a-zA-Z_-]+)*)\s*$", output)
        return {
            "present": True,
            "pid": int(pid_match.group(1)) if pid_match else None,
            "state": state_match.group(1) if state_match else None,
        }
    label = service.rsplit("/", 1)[-1]
    absent = 'Could not find service "' + label + '" in domain for user gui: ' + str(os.getuid())
    if result.returncode == 113 and absent in output:
        return {"present": False, "pid": None, "state": None}
    raise OSError("launchd service state could not be verified")


def _bootout(launchctl, service, deadline):
    result = _launchctl(launchctl, ["bootout", service], deadline)
    state = _service_state(launchctl, service, deadline)
    if not state["present"]:
        return True
    if result.returncode != 0:
        return False
    while clock_now() < deadline:
        time.sleep(min(POLL_SECONDS, max(0, deadline - clock_now())))
        state = _service_state(launchctl, service, deadline)
        if not state["present"]:
            return True
    return False


def _write_private_file(path, payload):
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        if os.write(descriptor, payload) != len(payload):
            raise OSError("private launchd input write was incomplete")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _copy_private_source(source, destination):
    payload = Path(source).read_bytes()
    _write_private_file(destination, payload)
    if hashlib.sha256(Path(destination).read_bytes()).digest() != hashlib.sha256(payload).digest():
        raise OSError("private launchd source copy failed verification")


def _read_job_state(path, owner, token, identity=None):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            state = json.load(handle)
    except FileNotFoundError:
        return None
    if not isinstance(state, dict) or state.get("launch_token") != token:
        raise ValueError("guardian state run did not match")
    owner.require_clock_contract(state.get("clock_contract"))
    contracts = {
        "ready": ("ready", False, False),
        "command": ("running", False, False),
        "body-quiescent": ("running", False, False),
        "normal-after-complete": ("running", False, False),
        "fallback-complete": ("running", False, False),
        "retired": ("finished", True, True),
        "cleanup-hold": ("cleanup-failed", True, False),
        "failed": ("failed", True, False),
    }
    phase = state.get("phase")
    if not isinstance(phase, str) or phase not in contracts:
        raise ValueError("guardian state phase is invalid")
    expected_state, sealed, quiescent = contracts[phase]
    if (state.get("state") != expected_state
            or type(state.get("sealed")) is not bool or state["sealed"] is not sealed
            or type(state.get("quiescent")) is not bool or state["quiescent"] is not quiescent
            or type(state.get("body_quiescent")) is not bool
            or state["body_quiescent"] is not (phase == "body-quiescent")
            or type(state.get("sequence")) is not int or state["sequence"] < 0):
        raise ValueError("guardian state lifecycle fields are invalid")
    reported = state.get("identity")
    if reported is None:
        if phase != "failed" or identity is not None:
            raise ValueError("guardian state identity is missing")
    else:
        keys = ("pid", "unique_id", "pid_version", "start_sec", "start_usec", "coalition_id")
        if (not isinstance(reported, dict)
                or any(type(reported.get(key)) is not int for key in keys)
                or reported["pid"] < 1 or reported["coalition_id"] < 1
                or any(reported[key] < 0 for key in keys)):
            raise ValueError("guardian state identity is invalid")
        if identity is not None and not owner.same_process(identity, reported):
            raise OSError("guardian phase identity changed")
    for key in ("reason", "detail", "body_reason", "body_detail"):
        if state.get(key) is not None and not isinstance(state[key], str):
            raise ValueError("guardian state diagnostic is invalid")
    if phase in ("retired", "cleanup-hold", "failed"):
        if type(state.get("code")) is not int or phase != "retired" and state["code"] != NO_VERDICT:
            raise ValueError("guardian terminal result is invalid")
    if phase == "ready" and state["sequence"] != 0:
        raise ValueError("guardian readiness sequence is invalid")
    if phase == "body-quiescent" and type(state.get("body_code")) is not int:
        raise ValueError("guardian body result is invalid")
    if phase in ("normal-after-complete", "fallback-complete"):
        failure = state.get("after_failure")
        if failure is None:
            if not isinstance(state.get("after"), dict) or "snapshot" not in state["after"]:
                raise ValueError("guardian comparison data is invalid")
        elif (not isinstance(failure, dict)
                or failure.get("reason") not in ("cleanup", "setup", "interrupted", "timeout", "stale")
                or not isinstance(failure.get("detail"), str)):
            raise ValueError("guardian comparison failure is invalid")
    return state


def _record_verdict_range(cursor, start, end, terminal):
    if terminal is None or not terminal.record_verdict_range(start, end):
        cursor.update(offset=start, retain_output=True, verdict_append_failed=True)
        return False
    if cursor.get("verdict") is None:
        cursor["verdict"] = (start, end)
    return True


def _stream_stdout(path, cursor, final=False, deadline=None, interrupted=None):
    if cursor.get("verdict_append_failed") or cursor.get("pending_marker_end") is not None:
        return None
    try:
        terminal = _ACTIVE_TERMINAL_OUTPUT
    except NameError:
        terminal = None
    if deadline is None and terminal is not None:
        deadline = terminal.deadline
    offset = cursor["offset"]
    try:
        with open(path, "rb") as handle:
            handle.seek(offset)
            payload = handle.read(64 * 1024)
    except FileNotFoundError:
        return offset
    marker = b"APERTURE-GATE-INDETERMINATE reason="
    pending = cursor.get("pending_marker")
    if pending is not None:
        newline = payload.find(b"\n")
        if newline >= 0:
            end = offset + newline + 1
            if not _record_verdict_range(cursor, pending, end, terminal):
                return None
            cursor.update(offset=end, pending_marker=None, pending_marker_end=None, source_line_start=True)
            return end
        if final and len(payload) < 64 * 1024:
            cursor.update(offset=pending, pending_marker_end=offset + len(payload))
            return None
        cursor["offset"] += len(payload)
        return cursor["offset"]
    if not payload:
        return offset
    starts_marker = cursor["source_line_start"] and payload.startswith(marker)
    at = 0 if starts_marker else payload.find(b"\n" + marker) + 1
    if at == 0 and not starts_marker:
        at = -1
    if at == 0:
        newline = payload.find(b"\n")
        if newline >= 0:
            end = offset + newline + 1
            if not _record_verdict_range(cursor, offset, end, terminal):
                return None
            cursor.update(offset=end, source_line_start=True)
            return end
        if not final or len(payload) == 64 * 1024:
            cursor.update(offset=offset + len(payload), pending_marker=offset)
            return cursor["offset"]
        cursor.update(pending_marker=offset, pending_marker_end=offset + len(payload))
        return None
    if at > 0:
        payload = payload[:at]
    elif not final or len(payload) == 64 * 1024:
        tail_at = payload.rfind(b"\n") + 1
        if tail_at or cursor["source_line_start"]:
            tail = payload[tail_at:]
            if tail and marker.startswith(tail):
                payload = payload[:tail_at]
    if not payload:
        return offset
    try:
        if interrupted is None:
            written = _write_job_output(sys.stdout.fileno(), payload, deadline)
        else:
            written = _write_job_output(sys.stdout.fileno(), payload, deadline, interrupted=interrupted)
    except (OSError, ValueError) as error:
        if terminal is not None:
            terminal.fail_output("live stdout relay failed: " + str(error))
        return offset
    if written:
        cursor["source_line_start"] = cursor["output_line_start"] = payload[written - 1:written] == b"\n"
        cursor["offset"] += written
    if written != len(payload) and (interrupted is None or not interrupted.is_set()):
        if terminal is not None:
            terminal.fail_output("live stdout relay was incomplete")
    return cursor["offset"]


def _emit_job_stderr(path, stdout_path, result, emit, cursor, deadline):
    if not emit:
        return True
    terminal = globals().get("_ACTIVE_TERMINAL_OUTPUT")
    if terminal is None:
        cursor["retain_output"] = True
        return False
    terminal.set_deadline(deadline)
    saved = cursor.get("verdict")
    if saved is not None:
        if result == NO_VERDICT:
            replay, candidate = False, True
            name = "candidate"
            start, end = saved
            if not terminal._marker_range_valid(stdout_path, start, end):
                cursor["retain_output"] = True
                return False
            if not terminal.add_file_range(
                name, stdout_path, start, end, replay=replay, candidate=candidate
            ):
                cursor["retain_output"] = True
                return False
        elif not terminal.stage_verdict_ranges(stdout_path):
            cursor["retain_output"] = True
            return False
    pending = cursor.get("pending_marker")
    if pending is not None:
        if not terminal.add_file_range("stdout", stdout_path, pending, cursor.get("pending_marker_end"), replay=False):
            cursor["retain_output"] = True
            return False
        terminal.outputs[-1]["pending_marker"] = True
    if not terminal.add_file("stderr", path, replay=True):
        cursor["retain_output"] = True
        return False
    return True


def _write_job_request(path, token, owner, identity, sequence, phase, interrupted, **values):
    cancelled = interrupted.is_set()
    requested_phase = phase
    if cancelled:
        phase = "stop"
        values = {"result_code": NO_VERDICT, "reason": "interrupted", "detail": "caller cancelled before phase publication"}
    payload = {"launch_token": token, "clock_contract": owner.CLOCK_CONTRACT,
        "identity": identity, "sequence": sequence, "phase": phase, "cancelled": cancelled, **values}
    temporary = path + ".phase-" + str(sequence)
    _write_private_file(temporary, json.dumps(payload, separators=(",", ":")).encode("ascii"))
    os.replace(temporary, path)
    if cancelled and requested_phase != "stop":
        raise JobRequestCancelled("caller cancellation sealed productive dispatch")


def _wait_job_phase(path, owner, identity, token, phases, sequence, deadline, interrupted, stdout_path, cursor):
    while clock_now() < deadline and not interrupted.is_set():
        _stream_stdout(stdout_path, cursor, deadline=deadline, interrupted=interrupted)
        state = _read_job_state(path, owner, token, identity)
        if state is not None:
            observed = state["sequence"]
            if observed > sequence or state["sealed"] is True and observed != sequence:
                raise OSError("guardian phase sequence changed")
            if state["sealed"] is True:
                return state, cursor["offset"]
            if state["phase"] in phases and observed == sequence:
                return state, cursor["offset"]
        time.sleep(min(POLL_SECONDS, max(0, deadline - clock_now())))
    return None, cursor["offset"]


def _darwin_cleanup(owner, launchctl, service, identity, deadline, status_path=None, identity_verified=False, *, token=None, sequence=None, terminal_state=None):
    if not status_path or not isinstance(token, str) or type(sequence) is not int or sequence < 0:
        return False
    try:
        state = _read_job_state(status_path, owner, token, identity)
        reported = state.get("identity") if state else None
        if identity is None and isinstance(reported, dict):
            identity = reported
            actual = owner.identity_if_present(int(identity["pid"]))
            if actual is not None and not owner.same_process(identity, actual):
                return False
        if identity is None:
            return False
        signalled = False
        while True:
            if (state and state["phase"] == "retired" and state["sequence"] == sequence
                    and state["sealed"] is True and state["quiescent"] is True):
                if terminal_state is not None:
                    terminal_state.update(state)
                if not clock_now() < deadline:
                    return False
                if not owner.drain(identity["coalition_id"], deadline, preserve=identity, allow_reaped=identity_verified):
                    return False
                if not _bootout(launchctl, service, deadline):
                    return False
                return owner.drain(identity["coalition_id"], deadline, allow_reaped=identity_verified) and not _service_state(launchctl, service, deadline)["present"]
            if not clock_now() < deadline:
                return False
            current = owner.identity_if_present(int(identity["pid"]))
            if current is None or not owner.same_process(identity, current):
                return False
            if not clock_now() < deadline:
                return False
            if not signalled:
                owner.signal_identity(identity, signal.SIGTERM, deadline)
                signalled = True
            time.sleep(min(POLL_SECONDS, max(0, deadline - clock_now())))
            state = _read_job_state(status_path, owner, token, identity)
    except (owner.CapabilityError, OSError, TimeoutError, ValueError, KeyError, TypeError):
        return False


def run_darwin_supervised(root, command, environment, started, receipt, interrupted):
    terminal = globals().get("_ACTIVE_TERMINAL_OUTPUT")
    environment.pop("NODE_OPTIONS", None)
    environment[SUPERVISOR_ENVIRONMENT] = DARWIN_LAUNCHD
    environment[SUPERVISOR_RECEIPT_ENVIRONMENT] = receipt.path
    environment[SUPERVISOR_TOKEN_ENVIRONMENT] = receipt.token
    environment["DISCORD_SURFACE_GATE_SUPERVISOR_PID"] = str(os.getpid())
    try:
        budget = caller_budget(environment)
    except InvalidGateBudget as error:
        print(str(error), file=sys.stderr)
        return 4
    deadline = started + budget
    if terminal is not None:
        terminal.set_deadline(deadline)
    preflight_deadline = deadline - CLEANUP_RESERVE_SECONDS
    if preflight_deadline <= clock_now():
        return no_verdict("capacity", "caller budget leaves no time for source verification and cleanup")
    try:
        before = capture_snapshot(root, environment, "before", preflight_deadline, interrupted, stop_deadline=deadline)
    except SnapshotCleanupError as error:
        return no_verdict("cleanup", str(error))
    except InvalidGateBudget as error:
        print(str(error), file=sys.stderr)
        return 4
    except InterruptedError as error:
        return no_verdict("interrupted", str(error))
    except TimeoutError as error:
        return no_verdict("timeout", str(error))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return no_verdict("setup", str(error))

    if terminal is None:
        raise OSError("terminal output owner is unavailable")

    remaining = int(deadline - clock_now() - CLEANUP_RESERVE_SECONDS)
    if remaining - before["slowest"] < 1:
        return no_verdict("capacity", "caller budget leaves no time for admission plus execution")
    environment["APERTURE_GATE_TIME_LEFT_S"] = str(remaining)
    reason = None
    detail = None
    sequence = 0
    output_offset = 0
    output_cursor = {"offset": 0, "source_line_start": True, "output_line_start": True}
    terminal.request(None, None, stdout_cursor=output_cursor, stdout_deadline=deadline)
    retirement = {}
    after_failure = None
    owner = None
    scratch = None
    owned_service = False
    identity = None
    identity_verified = False
    stdout_path = None
    stderr_path = None
    output_required = False
    output_staged = None
    result_code = NO_VERDICT

    def stage_outputs():
        nonlocal output_staged
        if not output_required:
            return True
        if owned_service:
            terminal.fail_output("required gate output remains owned at " + stdout_path + ", " + stderr_path)
            return False
        if output_staged is None:
            output_staged = False
            if output_cursor.get("pending_marker") is None:
                if not terminal.add_file_range("stdout", stdout_path, output_cursor["offset"], None, replay=True):
                    return False
            output_result = NO_VERDICT if reason is not None else result_code
            output_staged = _emit_job_stderr(
                stderr_path, stdout_path, output_result, True, output_cursor, deadline
            )
            if not output_staged:
                terminal.fail_output("required gate output staging was incomplete")
        return output_staged

    def retire_scratch():
        nonlocal scratch
        if scratch is None:
            return True
        if owned_service:
            terminal.fail_retirement("platform-owned scratch remains under active guardian custody at " + scratch)
            stage_outputs()
            return False
        if not stage_outputs():
            return False
        if output_cursor.get("retain_output"):
            terminal.fail_output("platform-owned scratch retains required output evidence")
            return False
        if not clock_now() < deadline:
            terminal.fail_retirement("platform-owned scratch retirement exceeded the caller deadline")
            return False
        try:
            shutil.rmtree(scratch)
        except OSError as error:
            terminal.fail_retirement("platform-owned scratch removal failed: " + str(error))
            return False
        if not clock_now() < deadline or os.path.lexists(scratch):
            terminal.fail_retirement("platform-owned scratch removal did not complete before the caller deadline")
            return False
        scratch = None
        return True

    launchctl = shutil.which("launchctl")
    if not launchctl:
        return no_verdict("setup", "launchctl is unavailable")
    try:
        owner = load_darwin_owner()
        controller = owner.joined_identity(os.getpid())
        scratch = tempfile.mkdtemp(prefix="dsg-darwin-", dir="/private/tmp")
        os.chmod(scratch, 0o700)
        environment["DISCORD_SURFACE_GATE_SCRATCH"] = scratch
        nonce = secrets.token_hex(16)
        label = "com.discordsurface.fullgate." + nonce
        domain = "gui/" + str(os.getuid())
        service = domain + "/" + label
        status_path = os.path.join(scratch, "state.json")
        ack_path = os.path.join(scratch, "ready.ack")
        spec_path = os.path.join(scratch, "job.json")
        plist_path = os.path.join(scratch, "job.plist")
        stdout_path = os.path.join(scratch, "stdout.log")
        stderr_path = os.path.join(scratch, "stderr.log")
        for path in (stdout_path, stderr_path):
            descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(descriptor)
        present = _service_state(launchctl, service, deadline)["present"]
        if present:
            if not retire_scratch():
                return no_verdict("cleanup", "private allocation could not be retired before the caller deadline")
            return no_verdict("setup", "the unique launchd label was already occupied")
        spec_payload = json.dumps({
            "state_path": status_path,
            "clock_contract": owner.CLOCK_CONTRACT,
            "ack_path": ack_path,
            "deadline": deadline,
            "run_deadline": deadline - CLEANUP_RESERVE_SECONDS,
            "launch_token": nonce,
            "controller": controller,
            "command": command,
            "cwd": str(root),
            "environment": environment,
            "snapshot_program": SNAPSHOT_PROGRAM,
        }, separators=(",", ":")).encode("utf-8")
        _write_private_file(spec_path, spec_payload)
        runner = Path(__file__).resolve().with_name("darwin-runner.py")
        runner_copy = os.path.join(scratch, "darwin-runner.py")
        owner_copy = os.path.join(scratch, "darwin.py")
        _copy_private_source(runner, runner_copy)
        _copy_private_source(runner.with_name("darwin.py"), owner_copy)
        _copy_private_source(Path(__file__).resolve(), os.path.join(scratch, "supervisor.py"))
        plist = {
            "Label": label,
            "ProgramArguments": [str(Path(sys.executable).resolve()), "-I", "-B", runner_copy, spec_path],
            "RunAtLoad": True,
            "KeepAlive": False,
            "StandardOutPath": stdout_path,
            "StandardErrorPath": stderr_path,
            "EnvironmentVariables": {"PATH": environment.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")},
        }
        with open(plist_path, "xb") as handle:
            plistlib.dump(plist, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(plist_path, 0o600)
        owned_service = True
        output_required = True
        result = _launchctl(launchctl, ["bootstrap", domain, plist_path], deadline)
        if result.returncode != 0:
            detail = (result.stderr + result.stdout).strip() or "launchctl bootstrap returned " + str(result.returncode)
            if _darwin_cleanup(owner, launchctl, service, None, deadline, status_path, False, token=nonce, sequence=sequence):
                owned_service = False
                reason, detail = "setup", "temporary launchd job did not start: " + detail
                retire_scratch()
                return no_verdict(reason, detail, stdout_cursor=output_cursor, stdout_deadline=deadline)
            custody = {
                "service": service,
                "state": "bootstrap-outcome-unresolved",
                "status_path": status_path,
            }
            _write_private_file(
                os.path.join(scratch, "allocation-custody.json"),
                json.dumps(custody, separators=(",", ":")).encode("utf-8"),
            )
            terminal.fail_retirement("launchd bootstrap did not prove allocation drain for " + service)
            stage_outputs()
            return no_verdict("cleanup", "launchd bootstrap did not prove allocation drain for " + service)

        run_deadline = deadline - CLEANUP_RESERVE_SECONDS
        state, output_offset = _wait_job_phase(status_path, owner, None, nonce, ("ready",), 0, run_deadline,
            interrupted, stdout_path, output_cursor)
        if state is None:
            reason = "interrupted" if interrupted.is_set() else "timeout"
            raise OSError("guardian readiness did not complete")
        owner.require_clock_contract(state.get("clock_contract"))
        reported = state.get("identity")
        if state.get("phase") != "ready" or not isinstance(reported, dict):
            raise OSError("launchd guardian did not establish readiness")
        identity = owner.joined_identity(int(reported["pid"]))
        if not owner.same_process(reported, identity) or identity["coalition_id"] == controller["coalition_id"]:
            raise OSError("launchd guardian identity changed")
        counts = owner.task_counts(identity["coalition_id"])
        service_state = _service_state(launchctl, service, deadline)
        if counts[0] < 1 or counts[1] > counts[0] or not service_state["present"] or service_state["pid"] != identity["pid"] or service_state["state"] != "running":
            raise OSError("launchd service identity did not match its ready guardian")
        identity_verified = True
        sequence += 1
        _write_job_request(ack_path, nonce, owner, identity, sequence, "command", interrupted)
        state, output_offset = _wait_job_phase(status_path, owner, identity, nonce, ("body-quiescent",), sequence,
            run_deadline, interrupted, stdout_path, output_cursor)
        if state is None:
            reason = "interrupted" if interrupted.is_set() else "timeout"
            raise OSError("body did not establish quiescence before relay")
        if state["phase"] != "body-quiescent" or state["body_quiescent"] is not True:
            reason = "cleanup"
            raise OSError("body cleanup remains unresolved")
        result_code = int(state["body_code"])
        reason, detail = state.get("body_reason"), state.get("body_detail")
        while not interrupted.is_set() and clock_now() < run_deadline:
            next_offset = _stream_stdout(
                stdout_path, output_cursor, final=True, deadline=run_deadline, interrupted=interrupted
            )
            if next_offset is None:
                break
            output_size = os.stat(stdout_path).st_size
            if next_offset == output_size and output_cursor.get("pending_marker") is None:
                output_offset = next_offset
                break
            if next_offset == output_offset:
                time.sleep(min(POLL_SECONDS, max(0, run_deadline - clock_now())))
            output_offset = next_offset
        else:
            output_cursor["retain_output"] = True
            if reason is None:
                reason = "interrupted" if interrupted.is_set() else "timeout"
                detail = "final stdout relay incomplete after body exit " + str(result_code)
        sequence += 1
        _write_job_request(ack_path, nonce, owner, identity, sequence, "normal-after", interrupted)
        state, output_offset = _wait_job_phase(status_path, owner, identity, nonce, ("normal-after-complete",), sequence,
            deadline, interrupted, stdout_path, output_cursor)
        if state is None or state.get("phase") != "normal-after-complete":
            raise OSError("source-after-unavailable: guardian did not complete normal verification")
        after_failure = state.get("after_failure")
        after = state.get("after")
        if isinstance(after_failure, dict):
            cause = after_failure.get("reason", "setup")
            if cause == "cleanup" or reason is None:
                reason, detail = cause, str(after_failure.get("detail", "source verification failed"))
        elif not isinstance(after, dict) or "snapshot" not in after:
            if reason is None:
                reason, detail = "stale", "source-after-unavailable: completed comparison data missing"
        elif reason is None and before["snapshot"] != after["snapshot"]:
            reason, detail = "stale", "source changed during supervised gate execution"
        sequence += 1
        _write_job_request(ack_path, nonce, owner, identity, sequence, "retire", interrupted,
            result_code=NO_VERDICT if reason else result_code, reason=reason, detail=detail)
        state, output_offset = _wait_job_phase(status_path, owner, identity, nonce, ("retired",), sequence,
            deadline, interrupted, stdout_path, output_cursor)
        if (state is None or state["phase"] != "retired" or state["sequence"] != sequence
                or state["sealed"] is not True or state["quiescent"] is not True):
            reason, detail = "cleanup", "guardian retains unresolved cleanup ownership"
        elif state.get("code") == NO_VERDICT and state.get("reason") and (state["reason"] == "cleanup" or reason is None):
            reason, detail = state["reason"], str(state.get("detail") or state["reason"])
        elif state.get("code") == NO_VERDICT and result_code != NO_VERDICT and reason is None:
            reason, detail = "cleanup", "guardian reported cleanup uncertainty"
        released = _darwin_cleanup(owner, launchctl, service, identity, deadline, status_path, identity_verified,
            token=nonce, sequence=sequence, terminal_state=retirement)
        if retirement.get("code") == NO_VERDICT and retirement.get("reason") and (retirement["reason"] == "cleanup" or reason is None):
            reason, detail = retirement["reason"], str(retirement.get("detail") or retirement["reason"])
        if not released:
            detail = (detail + "; " if reason == "cleanup" and detail else "") + "guardian or allocation remains owned; evidence retained"
            reason = "cleanup"
            terminal.fail_retirement("guardian or platform allocation remains under active custody")
        else:
            owned_service = False
        if not stage_outputs():
            if reason is None:
                reason, detail = "cleanup", "required output staging was incomplete after body exit " + str(result_code)
        if scratch is not None:
            if owned_service:
                if reason is None:
                    reason, detail = "cleanup", "platform-owned scratch remains under active custody"
                terminal.fail_retirement(detail)
            elif output_cursor.get("retain_output"):
                if reason is None:
                    reason, detail = "cleanup", "platform-owned scratch retains required output evidence"
                terminal.fail_output(detail)
            elif not retire_scratch():
                if reason is None:
                    reason, detail = "cleanup", "platform-owned scratch could not be retired within the caller deadline"
        return no_verdict(reason, detail or reason, stdout_cursor=output_cursor, stdout_deadline=deadline) if reason else result_code
    except (OSError, TimeoutError, ValueError, KeyError, TypeError) as error:
        detail = detail or str(error)
        reason = reason or ("interrupted" if isinstance(error, InterruptedError) else "setup")
        fallback_available = False
        fallback_window = False
        if interrupted.is_set() and identity_verified and not isinstance(error, JobRequestCancelled):
            try:
                sequence += 1
                _write_job_request(ack_path, nonce, owner, identity, sequence, "stop", interrupted,
                    result_code=NO_VERDICT, reason="interrupted", detail="caller cancelled")
            except (OSError, ValueError, KeyError, TypeError):
                pass
        if identity_verified and owner is not None and not interrupted.is_set():
            try:
                fallback_window = clock_now() < deadline - SNAPSHOT_STOP_RESERVE_SECONDS
            except OSError as clock_error:
                reason = "cleanup" if owned_service else reason
                detail += "; source-after-unavailable: " + str(clock_error)
        if fallback_window:
            try:
                state = _read_job_state(status_path, owner, nonce, identity)
                if (state and state["sealed"] is False and state["sequence"] == sequence
                        and state["phase"] in ("ready", "body-quiescent", "normal-after-complete")):
                    sequence += 1
                    _write_job_request(ack_path, nonce, owner, identity, sequence, "fallback", interrupted)
                    state, output_offset = _wait_job_phase(status_path, owner, identity, nonce, ("fallback-complete",), sequence,
                        deadline, interrupted, stdout_path, output_cursor)
                    if state and state.get("phase") == "fallback-complete":
                        fallback_available = True
                        failure = state.get("after_failure")
                        if isinstance(failure, dict) and failure.get("reason") == "cleanup":
                            reason, detail = "cleanup", str(failure.get("detail", "source verifier cleanup uncertain"))
                        sequence += 1
                        _write_job_request(ack_path, nonce, owner, identity, sequence, "retire", interrupted,
                            result_code=NO_VERDICT, reason=reason, detail=detail)
            except (OSError, TimeoutError, ValueError, KeyError, TypeError):
                fallback_available = False
        if not fallback_available:
            detail += "; source-after-unavailable: no safe guardian fallback"
        if owned_service and owner is not None:
            if _darwin_cleanup(owner, launchctl, service, identity, deadline, locals().get("status_path"), identity_verified, token=locals().get("nonce"), sequence=sequence, terminal_state=retirement):
                owned_service = False
            else:
                reason = "cleanup"
                detail += "; guardian/allocation custody retained"
                terminal.fail_retirement("guardian/allocation custody retained at " + str(scratch))
                stage_outputs()
        if retirement.get("reason") == "cleanup":
            reason = "cleanup"
            detail = str(retirement.get("detail") or "guardian reported cleanup uncertainty") + "; " + detail
        if not owned_service and retirement.get("sealed") is True and retirement.get("quiescent") is True:
            relay_complete = False
            try:
                output_offset = output_cursor["offset"]
                while clock_now() < deadline:
                    next_offset = _stream_stdout(stdout_path, output_cursor, final=True, deadline=deadline)
                    if next_offset is None:
                        break
                    if next_offset == os.stat(stdout_path).st_size and output_cursor.get("pending_marker") is None:
                        relay_complete = True
                        break
                    if next_offset == output_offset:
                        time.sleep(min(POLL_SECONDS, max(0, deadline - clock_now())))
                    output_offset = next_offset
            except (OSError, ValueError, TypeError):
                pass
            if not relay_complete:
                output_cursor["retain_output"] = True
                detail += "; final stdout relay incomplete; private evidence retained"
        if scratch is not None and not owned_service:
            stage_outputs()
            if output_cursor.get("retain_output"):
                terminal.fail_output("platform-owned scratch retains required output evidence")
            elif not retire_scratch():
                if reason is None:
                    reason, detail = "cleanup", "platform-owned scratch could not be retired within the caller deadline"
        return no_verdict(reason, detail, stdout_cursor=output_cursor, stdout_deadline=deadline)



def _run(argv):
    try:
        started = clock_now()
    except OSError as error:
        return no_verdict("setup", str(error))
    interrupted = threading.Event()
    previous_handlers = {}
    receipt = None
    terminal = _ACTIVE_TERMINAL_OUTPUT

    def receive_signal(_signum, _frame):
        interrupted.set()

    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        signum = getattr(signal, name, None)
        if signum is not None:
            previous_handlers[signum] = signal.signal(signum, receive_signal)

    try:
        try:
            separator = argv.index("--")
        except ValueError:
            return 2
        command = argv[separator + 1 :]
        if not command:
            return 2

        environment = os.environ.copy()
        if environment.get("NODE_OPTIONS"):
            return no_verdict("setup", "unset NODE_OPTIONS before starting the full gate")
        if sys.platform not in ("linux", "darwin"):
            return no_verdict("setup", "kernel-backed process ownership is unavailable on this host")
        try:
            budget = caller_budget(environment)
            if terminal is None:
                raise OSError("terminal output owner is unavailable")
            terminal.set_deadline(started + budget)
            if not terminal.prepare_recovery():
                return no_verdict("setup", "independent recovery custody is unavailable")
            establish_reaping_contract()
            if sys.platform == "linux":
                enable_subreaper()
            elif sys.platform == "darwin":
                load_darwin_owner().joined_identity(os.getpid())
            receipt = SupervisorReceipt()
        except (InvalidGateBudget, OSError) as error:
            return no_verdict("setup", str(error))
        if interrupted.is_set():
            return no_verdict("interrupted", "full gate was interrupted before launch")
        root = Path.cwd().resolve()
        if sys.platform == "linux":
            return run_supervised(root, command, environment, started, receipt, interrupted)
        return run_darwin_supervised(root, command, environment, started, receipt, interrupted)
    except OSError as error:
        return no_verdict("setup", str(error))
    finally:
        if receipt is not None:
            try:
                receipt.close()
            except OSError as error:
                terminal.fail_retirement("supervisor receipt removal failed: " + str(error))
        for signum, handler in previous_handlers.items():
            try:
                signal.signal(signum, handler)
            except (OSError, ValueError) as error:
                if terminal is not None:
                    terminal.fail_retirement("supervisor signal handler restoration failed: " + str(error))


def run(argv):
    global _ACTIVE_TERMINAL_OUTPUT
    terminal = TerminalOutput()
    previous = _ACTIVE_TERMINAL_OUTPUT
    _ACTIVE_TERMINAL_OUTPUT = terminal
    result = NO_VERDICT
    try:
        result = _run(argv)
    except OSError as error:
        terminal.request("setup", str(error))
    finally:
        terminal.close_captures()
        _ACTIVE_TERMINAL_OUTPUT = previous
    try:
        return terminal.publish(result)
    except Exception:
        return NO_VERDICT


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
