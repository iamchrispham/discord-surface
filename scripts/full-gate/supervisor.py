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


class InvalidGateBudget(Exception):
    pass


class SnapshotCleanupError(OSError):
    pass


class JobRequestCancelled(InterruptedError):
    pass


def _write_job_output(descriptor, payload, deadline=None):
    offset = 0
    attempted = False
    while offset < len(payload):
        if attempted:
            try:
                if not clock_now() < deadline:
                    break
            except OSError:
                break
        attempted = True
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


def no_verdict(reason, detail, *, stdout_cursor=None, stdout_deadline=None):
    prefix = "\n" if stdout_cursor and not stdout_cursor["output_line_start"] else ""
    line = prefix + "APERTURE-GATE-INDETERMINATE reason=" + reason + ": " + detail + "\n"
    try:
        payload = line.encode("utf-8", errors="replace")
        if stdout_cursor is None:
            os.write(sys.stdout.fileno(), payload)
        else:
            stdout_cursor["verdict_delivery_complete"] = _write_job_output(sys.stdout.fileno(), payload, stdout_deadline) == len(payload)
            stdout_cursor["retain_output"] = stdout_cursor.get("retain_output", False) or not stdout_cursor["verdict_delivery_complete"]
    except OSError:
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


def live_owned_children(excluded=()):
    excluded = set(excluded)
    live = []
    for pid in direct_children():
        if pid in excluded:
            continue
        try:
            waited, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            continue
        if waited == 0:
            live.append(pid)
    return live


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
        if not live_owned_children():
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
    if sys.platform == "darwin":
        if process is None:
            return True
        if process.returncode is None:
            # The verifier leads its own group. Until it is reaped, its pid keeps the group id from naming another group.
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
        children = live_owned_children(excluded)
        for pid in children:
            signal_owned_child(pid, signal.SIGTERM)
        if not process_live and not children:
            return True
        time.sleep(min(POLL_SECONDS, max(0, term_deadline - clock_now())))

    if process is not None and process.poll() is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    while clock_now() < deadline:
        process_live = process is not None and process.poll() is None
        excluded = {process.pid} if process_live else set()
        children = live_owned_children(excluded)
        for pid in children:
            signal_owned_child(pid, signal.SIGKILL)
        if not process_live and not children:
            return True
        time.sleep(min(POLL_SECONDS, max(0, deadline - clock_now())))
    return not (process is not None and process.poll() is None) and not live_owned_children()


def capture_snapshot(root, environment, phase, deadline, interrupted, *, stop_deadline):
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


def emit_child_stderr(capture, result):
    capture.seek(0)
    output = capture.read()
    marker = b"APERTURE-GATE-INDETERMINATE"
    if result == NO_VERDICT:
        for line in output.splitlines(keepends=True):
            if marker in line:
                os.write(sys.stderr.fileno(), line)
                return
        return
    if output:
        os.write(sys.stderr.fileno(), output)


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

    stderr_capture = tempfile.TemporaryFile(mode="w+b")
    process = None
    result = NO_VERDICT
    reason = None
    detail = None
    try:
        process = subprocess.Popen(
            command, cwd=str(root), env=environment, start_new_session=True,
            stdout=None, stderr=stderr_capture,
        )
        run_deadline = deadline - CLEANUP_RESERVE_SECONDS
        while process.poll() is None:
            if interrupted.is_set():
                reason, detail = "interrupted", "full gate was interrupted"
                break
            if clock_now() >= run_deadline:
                reason, detail = "timeout", "full gate exceeded the caller deadline"
                break
            time.sleep(min(POLL_SECONDS, max(0, run_deadline - clock_now())))
        if reason:
            if not stop_owned_processes(process, deadline):
                reason, detail = "cleanup", "supervised process tree did not stop before the caller deadline"
        else:
            result = process.wait()
            if not wait_for_owned_children(run_deadline):
                if not stop_owned_processes(None, deadline):
                    reason, detail = "cleanup", "detached descendants did not stop before the caller deadline"
                else:
                    reason, detail = "timeout", "descendant ownership could not be established before the caller deadline"

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
            return no_verdict(reason, detail or reason)
        if result < 0:
            return no_verdict("interrupted", "full gate ended from signal " + str(-result))
        emit_child_stderr(stderr_capture, result)
        return result
    except OSError as error:
        if process is not None and process.poll() is None:
            if not stop_owned_processes(process, deadline):
                return no_verdict("cleanup", "supervised process tree did not stop before the caller deadline")
        try:
            capture_snapshot(root, environment, "after", deadline, interrupted, stop_deadline=deadline)
        except SnapshotCleanupError as snapshot_error:
            return no_verdict("cleanup", str(snapshot_error))
        except Exception:
            return no_verdict("stale", "unable to verify source after setup failure")
        return no_verdict("setup", "full gate command could not start: " + str(error))
    finally:
        stderr_capture.close()


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


def _stream_stdout(path, cursor, final=False):
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
            if cursor.get("verdict") is None:
                cursor["verdict"] = (pending, end)
            cursor.update(offset=end, pending_marker=None, source_line_start=True)
            return end
        if final and len(payload) < 64 * 1024:
            cursor.update(offset=pending, pending_marker=None, ordinary_until=offset + len(payload))
            return pending
        cursor["offset"] += len(payload)
        return cursor["offset"]
    if not payload:
        return offset
    ordinary_until = cursor.get("ordinary_until", 0)
    if offset < ordinary_until:
        payload = payload[:ordinary_until - offset]
    else:
        at = 0 if cursor["source_line_start"] and payload.startswith(marker) else payload.find(b"\n" + marker) + 1
        if at == 0 and not (cursor["source_line_start"] and payload.startswith(marker)):
            at = -1
        if at == 0:
            newline = payload.find(b"\n")
            if newline >= 0:
                end = offset + newline + 1
                if cursor.get("verdict") is None:
                    cursor["verdict"] = (offset, end)
                cursor.update(offset=end, source_line_start=True)
                return end
            if not final or len(payload) == 64 * 1024:
                cursor.update(offset=offset + len(payload), pending_marker=offset)
                return cursor["offset"]
        elif at > 0:
            payload = payload[:at]
        if at < 0 and (not final or len(payload) == 64 * 1024):
            tail_at = payload.rfind(b"\n") + 1
            if tail_at or cursor["source_line_start"]:
                tail = payload[tail_at:]
                if tail and marker.startswith(tail):
                    payload = payload[:tail_at]
    if not payload:
        return offset
    written = _write_job_output(sys.stdout.fileno(), payload)
    if written:
        cursor["source_line_start"] = cursor["output_line_start"] = payload[written - 1:written] == b"\n"
        cursor["offset"] += written
    return cursor["offset"]


def _emit_job_stderr(path, stdout_path, result, emit, cursor, deadline):
    if not emit:
        return True
    try:
        output = Path(path).read_bytes()
    except OSError:
        output = b""
    marker = b"APERTURE-GATE-INDETERMINATE reason="
    if result == NO_VERDICT:
        saved = cursor.get("verdict")
        verdict = None
        if saved is not None:
            with open(stdout_path, "rb") as handle:
                handle.seek(saved[0])
                verdict = handle.read(saved[1] - saved[0])
        else:
            verdict = next((line for line in output.splitlines(keepends=True)
                if line.startswith(marker) and line.endswith(b"\n")), None)
        if verdict is not None:
            prefix = b"\n" if not cursor["output_line_start"] else b""
            cursor["verdict_delivery_complete"] = _write_job_output(sys.stdout.fileno(), prefix + verdict, deadline) == len(prefix + verdict)
            cursor["retain_output"] = cursor.get("retain_output", False) or not cursor["verdict_delivery_complete"]
            return True
    # Terminal selection has already rejected any earlier child verdict.
    output = b"".join(line for line in output.splitlines(keepends=True)
        if not (line.startswith(marker) and line.endswith(b"\n")))
    complete = _write_job_output(sys.stderr.fileno(), output, deadline) == len(output)
    cursor["retain_output"] = cursor.get("retain_output", False) or not complete
    return complete


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
        _stream_stdout(stdout_path, cursor)
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

    remaining = int(deadline - clock_now() - CLEANUP_RESERVE_SECONDS)
    if remaining - before["slowest"] < 1:
        return no_verdict("capacity", "caller budget leaves no time for admission plus execution")
    environment["APERTURE_GATE_TIME_LEFT_S"] = str(remaining)
    reason = None
    detail = None
    sequence = 0
    output_offset = 0
    output_cursor = {"offset": 0, "source_line_start": True, "output_line_start": True}
    retirement = {}
    after_failure = None
    owner = None
    scratch = None
    owned_service = False
    identity = None
    identity_verified = False
    launchctl = shutil.which("launchctl")
    if not launchctl:
        return no_verdict("setup", "launchctl is unavailable")
    try:
        owner = load_darwin_owner()
        controller = owner.joined_identity(os.getpid())
        scratch = tempfile.mkdtemp(prefix="dsg-darwin-", dir="/private/tmp")
        os.chmod(scratch, 0o700)
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
        result = _launchctl(launchctl, ["bootstrap", domain, plist_path], deadline)
        if result.returncode != 0:
            detail = (result.stderr + result.stdout).strip() or "launchctl bootstrap returned " + str(result.returncode)
            if _darwin_cleanup(owner, launchctl, service, None, deadline, status_path, False, token=nonce, sequence=sequence):
                owned_service = False
                return no_verdict("setup", "temporary launchd job did not start: " + detail)
            custody = {
                "service": service,
                "state": "bootstrap-outcome-unresolved",
                "status_path": status_path,
            }
            _write_private_file(
                os.path.join(scratch, "allocation-custody.json"),
                json.dumps(custody, separators=(",", ":")).encode("utf-8"),
            )
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
        output_cursor["retain_output"] = True
        while not interrupted.is_set() and clock_now() < run_deadline:
            next_offset = _stream_stdout(stdout_path, output_cursor, final=True)
            output_size = os.stat(stdout_path).st_size
            if next_offset == output_size and output_cursor.get("pending_marker") is None:
                output_cursor["retain_output"] = False
                output_offset = next_offset
                break
            if next_offset == output_offset:
                time.sleep(min(POLL_SECONDS, max(0, run_deadline - clock_now())))
            output_offset = next_offset
        else:
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
        else:
            owned_service = False
        if not _emit_job_stderr(stderr_path, stdout_path, result_code, reason is None, output_cursor, deadline):
            reason, detail = "timeout", "final stderr relay incomplete after body exit " + str(result_code)
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
        if retirement.get("reason") == "cleanup":
            reason = "cleanup"
            detail = str(retirement.get("detail") or "guardian reported cleanup uncertainty") + "; " + detail
        if not owned_service and retirement.get("sealed") is True and retirement.get("quiescent") is True:
            relay_complete = False
            try:
                output_offset = output_cursor["offset"]
                while clock_now() < deadline:
                    next_offset = _stream_stdout(stdout_path, output_cursor, final=True)
                    if next_offset == os.stat(stdout_path).st_size and output_cursor.get("pending_marker") is None:
                        relay_complete = True
                        break
                    if next_offset == output_offset:
                        time.sleep(min(POLL_SECONDS, max(0, deadline - clock_now())))
                    output_offset = next_offset
            except (OSError, ValueError, TypeError):
                pass
            output_cursor["retain_output"] = output_cursor.get("retain_output", False) or not relay_complete
            if not relay_complete:
                detail += "; final stdout relay incomplete; private evidence retained"
        return no_verdict(reason, detail, stdout_cursor=output_cursor, stdout_deadline=deadline)
    finally:
        if scratch and not owned_service and not output_cursor.get("retain_output"):
            shutil.rmtree(scratch, ignore_errors=True)


def run(argv):
    try:
        started = clock_now()
    except OSError as error:
        return no_verdict("setup", str(error))
    interrupted = threading.Event()
    previous_handlers = {}
    receipt = None

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
        try:
            caller_budget(environment)
            if sys.platform == "linux":
                enable_subreaper()
            elif sys.platform == "darwin":
                load_darwin_owner().joined_identity(os.getpid())
            else:
                return no_verdict("setup", "kernel-backed process ownership is unavailable on this host")
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
            receipt.close()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
