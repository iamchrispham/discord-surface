import ctypes
import json
import os
import secrets
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path


SUPERVISOR_ENVIRONMENT = "DISCORD_SURFACE_GATE_SUPERVISOR"
LINUX_SUBREAPER = "linux-subreaper-v1"
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
    print("APERTURE-GATE-INDETERMINATE reason=" + reason + ": " + detail, file=sys.stderr)
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


def capture_snapshot(root, environment, phase, deadline):
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
    try:
        output, error = process.communicate(timeout=remaining)
    except subprocess.TimeoutExpired as exc:
        stop_owned_processes(process, deadline)
        raise TimeoutError("source verification exceeded the gate deadline") from exc
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


def run_supervised(root, command, environment, started, receipt):
    environment.pop("NODE_OPTIONS", None)
    environment[SUPERVISOR_ENVIRONMENT] = LINUX_SUBREAPER
    environment[SUPERVISOR_RECEIPT_ENVIRONMENT] = receipt.path
    environment[SUPERVISOR_TOKEN_ENVIRONMENT] = receipt.token
    preflight_deadline = started + 7200
    try:
        before = capture_snapshot(root, environment, "before", preflight_deadline)
    except InvalidGateBudget as error:
        print(str(error), file=sys.stderr)
        return 4
    except TimeoutError as error:
        return no_verdict("timeout", str(error))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return no_verdict("setup", str(error))

    deadline = started + before["budget"]
    remaining = int(deadline - time.monotonic() - CLEANUP_RESERVE_SECONDS)
    if remaining - before["slowest"] < 1:
        return no_verdict("capacity", "caller budget leaves no time for admission plus execution")
    environment["APERTURE_GATE_TIME_LEFT_S"] = str(remaining)

    try:
        process = subprocess.Popen(command, cwd=str(root), env=environment, start_new_session=True)
    except OSError as error:
        return no_verdict("setup", "full gate command could not start: " + str(error))

    run_deadline = deadline - CLEANUP_RESERVE_SECONDS
    try:
        result = process.wait(timeout=max(0, run_deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        if not stop_owned_processes(process, deadline):
            return no_verdict("cleanup", "supervised process tree did not stop before the caller deadline")
        return no_verdict("timeout", "full gate exceeded the caller deadline")

    if not wait_for_owned_children(run_deadline):
        if not stop_owned_processes(None, deadline):
            return no_verdict("cleanup", "detached descendants did not stop before the caller deadline")
        return no_verdict("timeout", "descendant ownership could not be established before the caller deadline")
    if result < 0:
        return no_verdict("interrupted", "full gate ended from signal " + str(-result))
    if result != 0:
        return result

    try:
        after = capture_snapshot(root, environment, "after", deadline)
    except InvalidGateBudget as error:
        return no_verdict("setup", str(error))
    except TimeoutError as error:
        return no_verdict("timeout", str(error))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        return no_verdict("stale", "unable to verify source after execution: " + str(error))
    if not wait_for_owned_children(deadline - 0.1):
        if not stop_owned_processes(None, deadline):
            return no_verdict("cleanup", "source verifier descendants did not stop")
        return no_verdict("timeout", "source verification exceeded the gate deadline")
    if before["snapshot"] != after["snapshot"]:
        return no_verdict("stale", "source changed during supervised gate execution")
    return 0


def run(argv):
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
        enable_subreaper()
        receipt = SupervisorReceipt()
    except OSError as error:
        return no_verdict("setup", str(error))

    try:
        return run_supervised(Path.cwd().resolve(), command, environment, time.monotonic(), receipt)
    finally:
        receipt.close()


if __name__ == "__main__":
    raise SystemExit(run(sys.argv[1:]))
