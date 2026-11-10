"""One-shot launchd guardian for a full-gate command."""

import importlib.util
import json
import math
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
        current = DARWIN.identity_if_present(identity["pid"])
    except (DARWIN.CapabilityError, KeyError, TypeError):
        return False
    return current is not None and DARWIN.same_process(identity, current)


def run(spec_path):
    with open(spec_path, "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    state_path = spec["state_path"]
    try:
        DARWIN.require_clock_contract(spec.get("clock_contract"))
        deadline = float(spec["deadline"])
        run_deadline = float(spec["run_deadline"])
        if not math.isfinite(deadline) or not math.isfinite(run_deadline) or run_deadline >= deadline:
            raise DARWIN.CapabilityError("shared gate deadline is invalid")
        for name in ("SIGINT", "SIGTERM", "SIGHUP"):
            signal.signal(getattr(signal, name), receive_signal)
        identity = DARWIN.joined_identity(os.getpid())
        controller = spec["controller"]
        if identity["coalition_id"] == controller["coalition_id"]:
            raise DARWIN.CapabilityError("launchd did not isolate the job resource coalition")
        write_state(state_path, {"state": "ready", "identity": identity, "clock_contract": DARWIN.CLOCK_CONTRACT})
        if DARWIN.clock_now() >= run_deadline:
            raise DARWIN.CapabilityError("caller deadline expired before command launch")
        acknowledged = False
        while DARWIN.clock_now() < run_deadline:
            if interrupted:
                write_state(state_path, {"state": "interrupted", "identity": identity, "reason": "interrupted-before-dispatch"})
                return 98
            if not controller_alive(controller):
                write_state(state_path, {"state": "interrupted", "identity": identity, "reason": "guardian-lost-before-dispatch"})
                return 98
            try:
                with open(spec["ack_path"], "r", encoding="ascii") as handle:
                    acknowledgement = json.load(handle)
                DARWIN.require_clock_contract(acknowledgement.get("clock_contract"))
                acknowledged = acknowledgement["launch_token"] == spec["launch_token"]
            except FileNotFoundError:
                pass
            if acknowledged:
                break
            time.sleep(min(0.025, max(0, run_deadline - DARWIN.clock_now())))
        if not acknowledged:
            raise DARWIN.CapabilityError("supervisor readiness acknowledgement did not arrive")
        environment = dict(spec["environment"])
        raw_budget = environment.get("APERTURE_GATE_TIME_LEFT_S")
        if type(raw_budget) is not str or not raw_budget.isascii() or not raw_budget.isdecimal() or int(raw_budget) < 1:
            raise DARWIN.CapabilityError("caller budget must be a positive whole number of seconds")
        environment["DISCORD_SURFACE_GATE_SUPERVISOR_PID"] = str(controller["pid"])
        environment["DISCORD_SURFACE_GATE_JOB_PID"] = str(identity["pid"])
        remaining = min(int(raw_budget), int(run_deadline - DARWIN.clock_now()))
        if remaining < 1:
            raise DARWIN.CapabilityError("caller deadline expired before command launch")
        environment["APERTURE_GATE_TIME_LEFT_S"] = str(remaining)
    except Exception as error:
        write_state(state_path, {"state": "failed", "detail": str(error)})
        return 98

    try:
        process = subprocess.Popen(
            spec["command"], cwd=spec["cwd"], env=environment,
            stdin=None, stdout=None, stderr=None, start_new_session=False,
        )
    except OSError as error:
        write_state(state_path, {"state": "failed", "identity": identity, "detail": str(error)})
        return 98

    write_state(state_path, {"state": "running", "identity": identity, "command_pid": process.pid})
    while True:
        reason = None
        try:
            code = process.poll()
            if code is not None:
                write_state(state_path, {"state": "finished", "identity": identity, "code": code})
                return code
            if interrupted:
                reason = "interrupted"
            elif DARWIN.clock_now() >= run_deadline:
                reason = "timeout"
            elif not controller_alive(controller):
                reason = "guardian-lost"
            if reason is None:
                time.sleep(min(0.05, max(0, run_deadline - DARWIN.clock_now())))
                continue
        except DARWIN.CapabilityError:
            reason = "clock-unavailable"
        try:
            drained = DARWIN.drain(identity["coalition_id"], deadline, preserve=identity)
        except (DARWIN.CapabilityError, ProcessLookupError) as error:
            write_state(state_path, {"state": "cleanup-failed", "identity": identity, "reason": reason, "detail": str(error)})
            return 98
        write_state(state_path, {"state": "interrupted" if drained else "cleanup-failed", "identity": identity, "reason": reason})
        return 98


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(2)
    raise SystemExit(run(sys.argv[1]))
