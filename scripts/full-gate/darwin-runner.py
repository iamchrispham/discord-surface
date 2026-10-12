"""One-shot launchd guardian for a full-gate command."""

import importlib.util
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


DARWIN_PATH = Path(__file__).resolve().with_name("darwin.py")
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("full_gate_darwin", DARWIN_PATH)
DARWIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DARWIN)

interrupted = False


def receive_signal(_signum, _frame):
    global interrupted
    interrupted = True


def write_state(path, value):
    temporary = path + ".tmp-" + str(os.getpid())
    descriptor = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        payload = (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")
        if os.write(descriptor, payload) != len(payload):
            raise OSError("guardian state write was incomplete")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)


def controller_alive(identity):
    try:
        current = DARWIN.joined_identity(identity["pid"])
    except (DARWIN.CapabilityError, KeyError, TypeError):
        return False
    return DARWIN.same_process(identity, current)


def run(spec_path):
    with open(spec_path, "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    state_path = spec["state_path"]
    deadline = float(spec["deadline"])
    run_deadline = float(spec["run_deadline"])
    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        signal.signal(getattr(signal, name), receive_signal)

    try:
        identity = DARWIN.joined_identity(os.getpid())
        controller = spec["controller"]
        if identity["coalition_id"] == controller["coalition_id"]:
            raise DARWIN.CapabilityError("launchd did not isolate the job resource coalition")
        write_state(state_path, {"state": "ready", "identity": identity})
    except Exception as error:
        write_state(state_path, {"state": "failed", "detail": str(error)})
        return 98

    if time.monotonic() >= run_deadline:
        write_state(state_path, {"state": "failed", "detail": "caller deadline expired before command launch"})
        return 98

    acknowledged = False
    while time.monotonic() < run_deadline:
        if interrupted:
            write_state(state_path, {"state": "interrupted", "identity": identity, "reason": "interrupted-before-dispatch"})
            return 98
        if not controller_alive(controller):
            write_state(state_path, {"state": "interrupted", "identity": identity, "reason": "guardian-lost-before-dispatch"})
            return 98
        try:
            with open(spec["ack_path"], "r", encoding="ascii") as handle:
                acknowledged = handle.read().strip() == spec["launch_token"]
        except FileNotFoundError:
            pass
        if acknowledged:
            break
        time.sleep(min(0.025, max(0, run_deadline - time.monotonic())))
    if not acknowledged:
        write_state(state_path, {"state": "failed", "identity": identity, "detail": "supervisor readiness acknowledgement did not arrive"})
        return 98

    environment = dict(spec["environment"])
    environment["DISCORD_SURFACE_GATE_SUPERVISOR_PID"] = str(controller["pid"])
    environment["DISCORD_SURFACE_GATE_JOB_PID"] = str(identity["pid"])
    process = None
    try:
        process = subprocess.Popen(
            spec["command"], cwd=spec["cwd"], env=environment,
            stdin=None, stdout=None, stderr=None, start_new_session=False,
        )
    except OSError as error:
        write_state(state_path, {"state": "failed", "identity": identity, "detail": str(error)})
        return 98

    write_state(state_path, {"state": "running", "identity": identity, "command_pid": process.pid})
    reason = None
    while True:
        code = process.poll()
        if code is not None:
            write_state(state_path, {"state": "finished", "identity": identity, "code": code})
            return code
        if interrupted:
            reason = "interrupted"
        elif time.monotonic() >= run_deadline:
            reason = "timeout"
        elif not controller_alive(controller):
            reason = "guardian-lost"
        if reason:
            try:
                drained = DARWIN.drain(identity["coalition_id"], deadline, preserve=identity)
            except DARWIN.CapabilityError as error:
                write_state(state_path, {"state": "cleanup-failed", "identity": identity, "reason": reason, "detail": str(error)})
                return 98
            write_state(state_path, {"state": "interrupted" if drained else "cleanup-failed", "identity": identity, "reason": reason})
            return 98
        time.sleep(min(0.05, max(0, run_deadline - time.monotonic())))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(2)
    raise SystemExit(run(sys.argv[1]))
