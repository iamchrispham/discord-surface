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
SUPERVISOR_RECEIPT_ENVIRONMENT = "DISCORD_SURFACE_GATE_SUPERVISOR_RECEIPT"
SUPERVISOR_TOKEN_ENVIRONMENT = "DISCORD_SURFACE_GATE_SUPERVISOR_TOKEN"
NO_VERDICT = 98
CLEANUP_RESERVE_SECONDS = 5
TERMINATION_GRACE_SECONDS = 1
POLL_SECONDS = 0.025
GATE_MODULE = Path(__file__).resolve().parents[2] / "scripts" / "full-gate.js"
SNAPSHOT_PROGRAM = (
    "const gate = require(" + json.dumps(str(GATE_MODULE)) + ");"
    "try { process.stdout.write(gate.supervisorSnapshot(process.cwd(), "
    "process.argv[1])); } catch (error) {"
    "process.stderr.write(error.message + '\\n'); process.exitCode = error.code === 'ETIMEDOUT' ? 98 : 4; }"
)


class InvalidGateBudget(Exception):
    pass


def no_verdict(reason, detail):
    line = "APERTURE-GATE-INDETERMINATE reason=" + reason + ": " + detail + "\n"
    try:
        os.write(sys.stdout.fileno(), line.encode("utf-8", errors="replace"))
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
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(POLL_SECONDS, remaining))


def stop_owned_processes(process, deadline):
    if sys.platform == "darwin":
        if process is None or process.poll() is not None:
            return True
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        term_deadline = min(deadline, time.monotonic() + TERMINATION_GRACE_SECONDS)
        while process.poll() is None and time.monotonic() < term_deadline:
            time.sleep(min(POLL_SECONDS, max(0, deadline - time.monotonic())))
        if process.poll() is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
        while process.poll() is None and time.monotonic() < deadline:
            time.sleep(min(POLL_SECONDS, max(0, deadline - time.monotonic())))
        return process.poll() is not None
    if process is not None and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    term_deadline = min(deadline, time.monotonic() + TERMINATION_GRACE_SECONDS)
    while time.monotonic() < term_deadline:
        process_live = process is not None and process.poll() is None
        excluded = {process.pid} if process_live else set()
        children = live_owned_children(excluded)
        for pid in children:
            signal_owned_child(pid, signal.SIGTERM)
        if not process_live and not children:
            return True
        time.sleep(min(POLL_SECONDS, max(0, term_deadline - time.monotonic())))

    if process is not None and process.poll() is None:
        try:
            process.kill()
        except ProcessLookupError:
            pass
    while time.monotonic() < deadline:
        process_live = process is not None and process.poll() is None
        excluded = {process.pid} if process_live else set()
        children = live_owned_children(excluded)
        for pid in children:
            signal_owned_child(pid, signal.SIGKILL)
        if not process_live and not children:
            return True
        time.sleep(min(POLL_SECONDS, max(0, deadline - time.monotonic())))
    return not (process is not None and process.poll() is None) and not live_owned_children()


def capture_snapshot(root, environment, phase, deadline, interrupted=None):
    remaining = deadline - time.monotonic()
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
    while True:
        remaining = deadline - time.monotonic()
        if interrupted is not None and interrupted.is_set():
            if not stop_owned_processes(process, deadline):
                raise TimeoutError("interrupted source verifier did not stop before the caller deadline")
            raise InterruptedError("source verification interrupted")
        if remaining <= 0:
            stop_owned_processes(process, deadline)
            raise TimeoutError("source verification exceeded the gate deadline")
        try:
            output, error = process.communicate(timeout=min(remaining, POLL_SECONDS))
            break
        except subprocess.TimeoutExpired:
            continue
    if sys.platform == "linux":
        cleanup_deadline = min(deadline, time.monotonic() + CLEANUP_RESERVE_SECONDS)
        if not wait_for_owned_children(cleanup_deadline):
            stop_owned_processes(None, deadline)
            raise TimeoutError("source snapshot left live descendants")
    if process.returncode == 4:
        raise InvalidGateBudget(error.strip() or "gate budget is invalid")
    if process.returncode == NO_VERDICT:
        raise TimeoutError(error.strip() or "source verification exceeded the gate deadline")
    if process.returncode != 0:
        raise OSError(error.strip() or "source snapshot failed")
    return json.loads(output)


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
    if preflight_deadline <= time.monotonic():
        return no_verdict("capacity", "caller budget leaves no time for source verification and cleanup")
    try:
        before = capture_snapshot(root, environment, "before", preflight_deadline, interrupted)
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
    remaining = int(deadline - time.monotonic() - CLEANUP_RESERVE_SECONDS)
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
            if time.monotonic() >= run_deadline:
                reason, detail = "timeout", "full gate exceeded the caller deadline"
                break
            time.sleep(min(POLL_SECONDS, max(0, run_deadline - time.monotonic())))
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
            after = capture_snapshot(root, environment, "after", deadline, interrupted)
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
            capture_snapshot(root, environment, "after", deadline, interrupted)
        except Exception:
            return no_verdict("stale", "unable to verify source after setup failure")
        return no_verdict("setup", "full gate command could not start: " + str(error))
    finally:
        stderr_capture.close()


def load_darwin_owner():
    sys.dont_write_bytecode = True
    module_path = Path(__file__).resolve().with_name("darwin.py")
    spec = importlib.util.spec_from_file_location("full_gate_darwin", module_path)
    if spec is None or spec.loader is None:
        raise OSError("Darwin process-ownership helper could not load")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _launchctl(launchctl, arguments, deadline):
    remaining = deadline - time.monotonic()
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
    while time.monotonic() < deadline:
        time.sleep(min(POLL_SECONDS, max(0, deadline - time.monotonic())))
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


def _read_job_state(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            state = json.load(handle)
    except FileNotFoundError:
        return None
    if not isinstance(state, dict) or not isinstance(state.get("state"), str):
        raise ValueError("launchd guardian returned an invalid state record")
    return state


def _stream_stdout(path, offset):
    try:
        with open(path, "rb") as handle:
            handle.seek(offset)
            payload = handle.read()
    except FileNotFoundError:
        return offset
    if not payload:
        return offset
    try:
        was_blocking = os.get_blocking(sys.stdout.fileno())
        os.set_blocking(sys.stdout.fileno(), False)
        os.write(sys.stdout.fileno(), payload)
        os.set_blocking(sys.stdout.fileno(), was_blocking)
        return offset + len(payload)
    except (BlockingIOError, BrokenPipeError, OSError):
        try:
            os.set_blocking(sys.stdout.fileno(), True)
        except OSError:
            pass
        return offset + len(payload)


def _emit_job_stderr(path, stdout_path, result, emit):
    if not emit:
        return
    try:
        output = Path(path).read_bytes()
    except OSError:
        return
    marker = b"APERTURE-GATE-INDETERMINATE"
    if result == NO_VERDICT:
        try:
            if marker in Path(stdout_path).read_bytes():
                return
        except OSError:
            pass
        for line in output.splitlines(keepends=True):
            if marker in line:
                os.write(sys.stderr.fileno(), line)
                return
    if output:
        os.write(sys.stderr.fileno(), output)


def _darwin_cleanup(owner, launchctl, service, identity, deadline, status_path=None, identity_verified=False):
    try:
        removed = _bootout(launchctl, service, deadline)
    except (OSError, TimeoutError):
        return False
    if not removed:
        return False
    if identity is None and status_path:
        try:
            state = _read_job_state(status_path)
            reported = state.get("identity") if state else None
            if isinstance(reported, dict):
                identity = owner.joined_identity(int(reported["pid"]))
                if not owner.same_process(reported, identity):
                    return False
        except (owner.CapabilityError, OSError, ValueError, KeyError, TypeError):
            return False
    if identity is None:
        return False
    try:
        if not owner.drain(identity["coalition_id"], deadline, allow_reaped=identity_verified):
            return False
        return not _service_state(launchctl, service, deadline)["present"]
    except (owner.CapabilityError, OSError, TimeoutError):
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
    if preflight_deadline <= time.monotonic():
        return no_verdict("capacity", "caller budget leaves no time for source verification and cleanup")
    try:
        before = capture_snapshot(root, environment, "before", preflight_deadline, interrupted)
    except InvalidGateBudget as error:
        print(str(error), file=sys.stderr)
        return 4
    except InterruptedError as error:
        return no_verdict("interrupted", str(error))
    except TimeoutError as error:
        return no_verdict("timeout", str(error))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return no_verdict("setup", str(error))

    remaining = int(deadline - time.monotonic() - CLEANUP_RESERVE_SECONDS)
    if remaining - before["slowest"] < 1:
        return no_verdict("capacity", "caller budget leaves no time for admission plus execution")
    environment["APERTURE_GATE_TIME_LEFT_S"] = str(remaining)
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
            "ack_path": ack_path,
            "deadline": deadline,
            "run_deadline": deadline - CLEANUP_RESERVE_SECONDS,
            "launch_token": nonce,
            "controller": controller,
            "command": command,
            "cwd": str(root),
            "environment": environment,
        }, separators=(",", ":")).encode("utf-8")
        _write_private_file(spec_path, spec_payload)
        runner = Path(__file__).resolve().with_name("darwin-runner.py")
        runner_copy = os.path.join(scratch, "darwin-runner.py")
        owner_copy = os.path.join(scratch, "darwin.py")
        _copy_private_source(runner, runner_copy)
        _copy_private_source(runner.with_name("darwin.py"), owner_copy)
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
            if _darwin_cleanup(owner, launchctl, service, None, deadline, status_path, False):
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

        output_offset = 0
        job_state = None
        ready_validated = False
        result_code = NO_VERDICT
        reason = None
        detail = None
        run_deadline = deadline - CLEANUP_RESERVE_SECONDS
        while time.monotonic() < run_deadline:
            output_offset = _stream_stdout(stdout_path, output_offset)
            if interrupted.is_set():
                reason, detail = "interrupted", "full gate was interrupted"
                break
            job_state = _read_job_state(status_path)
            if job_state is not None:
                if job_state["state"] == "ready" and not ready_validated:
                    reported = job_state.get("identity")
                    if not isinstance(reported, dict):
                        reason, detail = "setup", "launchd guardian did not establish process identity"
                        break
                    identity = owner.joined_identity(int(reported["pid"]))
                    if not owner.same_process(reported, identity):
                        reason, detail = "setup", "launchd guardian identity changed"
                        break
                    if identity["coalition_id"] == controller["coalition_id"]:
                        reason, detail = "setup", "launchd job shares the caller resource coalition"
                        break
                    counts = owner.task_counts(identity["coalition_id"])
                    if counts[0] < 1 or counts[1] > counts[0]:
                        reason, detail = "setup", "launchd guardian coalition counters are invalid"
                        break
                    service_state = _service_state(launchctl, service, deadline)
                    if not service_state["present"] or service_state["pid"] != identity["pid"] or service_state["state"] != "running":
                        reason, detail = "setup", "launchd service identity did not match its ready guardian"
                        break
                    identity_verified = True
                    _write_private_file(ack_path, (nonce + "\n").encode("ascii"))
                    ready_validated = True
                elif job_state["state"] in ("running", "finished", "interrupted", "cleanup-failed") and not ready_validated:
                    reason, detail = "setup", "launchd guardian skipped verified readiness"
                    break
                if job_state["state"] == "finished":
                    result_code = int(job_state["code"])
                    break
                if job_state["state"] == "interrupted":
                    reason, detail = "interrupted", str(job_state.get("reason", "launchd guardian was interrupted"))
                    break
                if job_state["state"] == "failed":
                    reason, detail = "setup", str(job_state.get("detail", "launchd guardian could not start"))
                    break
                if job_state["state"] == "cleanup-failed":
                    reason, detail = "cleanup", str(job_state.get("detail", "launchd guardian cleanup failed"))
                    break
            time.sleep(min(POLL_SECONDS, max(0, run_deadline - time.monotonic())))
        else:
            reason, detail = "timeout", "full gate exceeded the caller deadline"
        if interrupted.is_set() and reason is None:
            reason, detail = "interrupted", "full gate was interrupted"

        if identity is not None:
            state = _service_state(launchctl, service, deadline)
            if reason is None and state["present"] and state["state"] not in ("exited", "not running"):
                while time.monotonic() < deadline - 0.1:
                    output_offset = _stream_stdout(stdout_path, output_offset)
                    time.sleep(min(POLL_SECONDS, max(0, deadline - 0.1 - time.monotonic())))
                    state = _service_state(launchctl, service, deadline)
                    if not state["present"] or state["state"] in ("exited", "not running"):
                        break
                if state["present"] and state["state"] not in ("exited", "not running"):
                    reason, detail = "cleanup", "launchd guardian did not exit after command completion"
        if owned_service:
            if not _darwin_cleanup(owner, launchctl, service, identity, deadline, status_path, identity_verified):
                reason, detail = "cleanup", "temporary launchd job or resource coalition did not drain"
            else:
                owned_service = False
        output_offset = _stream_stdout(stdout_path, output_offset)

        try:
            after = capture_snapshot(root, environment, "after", deadline, interrupted)
        except InterruptedError as error:
            if reason is None:
                reason, detail = "interrupted", str(error)
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
        _emit_job_stderr(stderr_path, stdout_path, result_code, True)
        return result_code
    except (OSError, TimeoutError, ValueError, KeyError, TypeError) as error:
        if owned_service and owner is not None:
            if _darwin_cleanup(owner, launchctl, service, identity, deadline, locals().get("status_path"), identity_verified):
                owned_service = False
        if scratch:
            try:
                capture_snapshot(root, environment, "after", deadline, interrupted)
            except Exception:
                pass
        return no_verdict("cleanup" if owned_service else "setup", str(error))
    finally:
        if scratch and not owned_service:
            shutil.rmtree(scratch, ignore_errors=True)


def run(argv):
    started = time.monotonic()
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
    finally:
        if receipt is not None:
            receipt.close()
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
