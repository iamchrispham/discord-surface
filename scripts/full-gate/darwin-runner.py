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
from types import SimpleNamespace


DARWIN_PATH = Path(__file__).resolve().with_name("darwin.py")
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("full_gate_darwin", DARWIN_PATH)
DARWIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DARWIN)

interrupted = False


def receive_signal(_signum, _frame):
    global interrupted
    interrupted = True


def write_state(spec, value):
    path = spec["state_path"]
    value = {"launch_token": spec["launch_token"], "clock_contract": DARWIN.CLOCK_CONTRACT,
        "quiescent": False, "body_quiescent": False, **value}
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


def quiescent(identity):
    try:
        actual = DARWIN.joined_identity(os.getpid())
        if not DARWIN.same_process(identity, actual) or actual["coalition_id"] != identity["coalition_id"]:
            return False
        started, exited = DARWIN.task_counts(identity["coalition_id"])
        return started - exited == 1 and DARWIN._drained(identity["coalition_id"], identity, False)
    except (DARWIN.CapabilityError, OSError, ValueError, KeyError, TypeError):
        return False


def retirement_result(value, body_code):
    result = value.get("result_code", 98)
    if type(result) is not int or result not in (body_code, 98):
        raise ValueError("retirement result did not match body")
    return result


def finish(spec, identity, sequence, code, reason, detail, *, body_code=None):
    # A cancelled controller publishes stop before signalling its guardian.
    try:
        if DARWIN.clock_now() < float(spec["deadline"]):
            stop = request(spec, identity, sequence, ("stop",), 0, observe_only=True,
                body_code=code if body_code is None else body_code)
            if stop is not None:
                sequence = stop["sequence"]
                code = 98
                reason = reason or "interrupted"
                detail = detail or stop.get("detail") or "authenticated stop sealed guardian retirement"
    except InterruptedError as error:
        code = 98
        reason = reason or "interrupted"
        detail = detail or str(error)
    except (DARWIN.CapabilityError, OSError, ValueError, KeyError, TypeError) as error:
        code, reason = 98, "cleanup"
        detail = (detail + "; " if detail else "") + "stop acknowledgement could not be verified: " + str(error)
    # Sealing is irreversible: this function cannot dispatch a command or verifier.
    drained = False
    try:
        cleanup_now = DARWIN.clock_now()
    except DARWIN.CapabilityError as error:
        cleanup_now = None
        code, reason = 98, "cleanup"
        detail = (detail + "; " if detail else "") + "cleanup clock could not be verified: " + str(error)
    try:
        if cleanup_now is None or cleanup_now < float(spec["deadline"]):
            drained = DARWIN.drain(identity["coalition_id"], float(spec["deadline"]), preserve=identity)
    except (DARWIN.CapabilityError, OSError, ValueError, KeyError, TypeError):
        pass
    if not drained:
        code, reason = 98, "cleanup"
        detail = detail or "owned descendants remain unresolved"
    holding_published = False
    while True:
        known = quiescent(identity)
        if not known:
            code, reason = 98, "cleanup"
            detail = detail or "owned descendants remain unresolved"
        payload = {"state": "finished" if known else "cleanup-failed",
            "phase": "retired" if known else "cleanup-hold", "sequence": sequence,
            "identity": identity, "sealed": True, "quiescent": known,
            "code": code, "reason": reason, "detail": detail}
        published = False
        try:
            if known or not holding_published:
                write_state(spec, payload)
                holding_published = not known
            published = True
        except OSError as error:
            code, reason, detail = 98, "cleanup", "guardian state publication failed: " + str(error)
        if known and published:
            return code
        # Conditional lifetime proposal: kernel observation only after the deadline.
        time.sleep(0.025)


def request(spec, identity, sequence, allowed, until, *, observe_only=False, body_code=98,
        cancellation_observed=False):
    final_peek = cancellation_observed
    cancellation_reason = "interrupted" if cancellation_observed else None
    while cancellation_observed or observe_only or DARWIN.clock_now() < until:
        if DARWIN.clock_now() >= float(spec["deadline"]):
            raise TimeoutError("timeout")
        pending = None
        try:
            with open(spec["ack_path"], "r", encoding="ascii") as handle:
                value = json.load(handle)
        except FileNotFoundError:
            value = None
        if value is not None:
            if not isinstance(value, dict) or type(value.get("cancelled")) is not bool:
                raise ValueError("guardian request cancellation field is invalid")
            DARWIN.require_clock_contract(value.get("clock_contract"))
            reported = value.get("identity")
            if (not isinstance(reported, dict)
                    or any(type(reported.get(key)) is not int for key in identity)
                    or value.get("launch_token") != spec["launch_token"]
                    or not DARWIN.same_process(identity, reported)):
                raise ValueError("guardian request identity did not match")
            incoming = value.get("sequence")
            if type(incoming) is not int or incoming < 1:
                raise ValueError("guardian request sequence is invalid")
            if incoming > sequence:
                if incoming != sequence + 1 or value.get("phase") not in allowed:
                    raise ValueError("guardian request is out of phase")
                if value["cancelled"] and value["phase"] != "stop":
                    raise InterruptedError("cancelled request cannot dispatch productive work")
                for key in ("reason", "detail"):
                    if value.get(key) is not None and not isinstance(value[key], str):
                        raise ValueError("guardian request diagnostic is invalid")
                if value["phase"] in ("stop", "retire"):
                    retirement_result(value, body_code)
                pending = value
        observed = "interrupted" if interrupted else "guardian-lost" if not controller_alive(spec["controller"]) else None
        if observed is not None or cancellation_observed:
            cancellation_reason = cancellation_reason or observed
            cancellation_observed = True
            if pending is None or pending["phase"] != "stop":
                if not final_peek:
                    final_peek = True
                    continue
                raise InterruptedError(cancellation_reason or "interrupted")
        if pending is not None:
            if DARWIN.clock_now() >= float(spec["deadline"]):
                raise TimeoutError("timeout")
            return pending
        if observe_only:
            return None
        time.sleep(min(0.025, max(0, until - DARWIN.clock_now())))
    raise TimeoutError("timeout")


def snapshot(spec, identity, owner, sequence, body_code=98):
    outcome, failure = None, None
    stop_sequence = None

    def should_stop():
        nonlocal stop_sequence
        if stop_sequence is not None:
            return True
        try:
            value = request(spec, identity, sequence, ("stop",), 0,
                observe_only=True, body_code=body_code)
            if value is None and (interrupted or not controller_alive(spec["controller"])):
                value = request(spec, identity, sequence, ("stop",), 0,
                    observe_only=True, body_code=body_code, cancellation_observed=True)
        except InterruptedError:
            return True
        if value is not None:
            stop_sequence = value["sequence"]
            return True
        return False

    try:
        outcome = owner.capture_snapshot(Path(spec["cwd"]), spec["environment"], "after",
            float(spec["deadline"]), SimpleNamespace(is_set=should_stop),
            stop_deadline=float(spec["deadline"]))
    except owner.SnapshotCleanupError as error:
        failure = {"reason": "cleanup", "detail": str(error)}
    except owner.InvalidGateBudget as error:
        failure = {"reason": "setup", "detail": str(error)}
    except InterruptedError as error:
        failure = {"reason": "interrupted", "detail": str(error)}
    except TimeoutError as error:
        failure = {"reason": "timeout", "detail": str(error)}
    except (OSError, ValueError, KeyError, TypeError) as error:
        failure = {"reason": "stale", "detail": "unable to verify source after execution: " + str(error)}
    return outcome, failure, stop_sequence


def run(spec_path):
    with open(spec_path, "r", encoding="utf-8") as handle:
        spec = json.load(handle)
    identity = None
    sequence = 0
    code = 98
    body_reason = None
    body_detail = None
    normal_done = False
    fallback_done = False
    failed = False
    try:
        DARWIN.require_clock_contract(spec.get("clock_contract"))
        deadline = float(spec["deadline"])
        run_deadline = float(spec["run_deadline"])
        if not math.isfinite(deadline) or not math.isfinite(run_deadline) or run_deadline >= deadline:
            raise DARWIN.CapabilityError("shared gate deadline is invalid")
        for name in ("SIGINT", "SIGTERM", "SIGHUP"):
            signal.signal(getattr(signal, name), receive_signal)
        candidate_identity = DARWIN.joined_identity(os.getpid())
        if candidate_identity["coalition_id"] == spec["controller"]["coalition_id"]:
            raise DARWIN.CapabilityError("launchd did not isolate the job resource coalition")
        identity = candidate_identity
        owner_spec = importlib.util.spec_from_file_location("full_gate_snapshot_owner", Path(__file__).resolve().with_name("supervisor.py"))
        if owner_spec is None or owner_spec.loader is None:
            raise OSError("source snapshot owner could not load")
        owner = importlib.util.module_from_spec(owner_spec)
        owner_spec.loader.exec_module(owner)
        owner._DARWIN_OWNER = DARWIN
        owner.SNAPSHOT_PROGRAM = spec["snapshot_program"]
        write_state(spec, {"state": "ready", "phase": "ready", "sequence": 0,
            "identity": identity, "clock_contract": DARWIN.CLOCK_CONTRACT, "sealed": False})
        value = request(spec, identity, sequence, ("command", "fallback", "retire", "stop"), run_deadline, body_code=code)
        sequence = value["sequence"]
        if value["phase"] == "command":
            environment = dict(spec["environment"])
            raw_budget = environment.get("APERTURE_GATE_TIME_LEFT_S")
            if type(raw_budget) is not str or not raw_budget.isascii() or not raw_budget.isdecimal() or int(raw_budget) < 1:
                raise ValueError("caller budget must be a positive whole number of seconds")
            remaining = min(int(raw_budget), int(run_deadline - DARWIN.clock_now()))
            if remaining < 1:
                raise TimeoutError("timeout")
            environment["APERTURE_GATE_TIME_LEFT_S"] = str(remaining)
            environment["DISCORD_SURFACE_GATE_SUPERVISOR_PID"] = str(spec["controller"]["pid"])
            environment["DISCORD_SURFACE_GATE_JOB_PID"] = str(identity["pid"])
            if interrupted or not controller_alive(spec["controller"]) or DARWIN.clock_now() >= run_deadline:
                raise InterruptedError("interrupted-before-dispatch")
            try:
                process = subprocess.Popen(spec["command"], cwd=spec["cwd"], env=environment,
                    stdin=None, stdout=None, stderr=None, start_new_session=False)
            except OSError as error:
                body_reason, body_detail = "setup", str(error)
            else:
                write_state(spec, {"state": "running", "phase": "command", "sequence": sequence,
                    "identity": identity, "command_pid": process.pid, "sealed": False})
                while True:
                    try:
                        stop = request(spec, identity, sequence, ("stop",), 0, observe_only=True, body_code=code)
                        if stop is not None:
                            sequence = stop["sequence"]
                            return finish(spec, identity, sequence, 98, "interrupted", "caller cancellation sealed body dispatch", body_code=code)
                        result = process.poll()
                        if result is not None:
                            if result < 0:
                                code = 98
                                body_reason = "interrupted"
                                body_detail = "gate command was terminated by signal " + str(-result)
                            else:
                                code = result
                            break
                        if interrupted:
                            body_reason, body_detail = "interrupted", "interrupted"
                        elif DARWIN.clock_now() >= run_deadline:
                            body_reason, body_detail = "interrupted", "timeout"
                        elif not controller_alive(spec["controller"]):
                            body_reason, body_detail = "interrupted", "guardian-lost"
                    except DARWIN.CapabilityError:
                        body_reason, body_detail = "interrupted", "clock-unavailable"
                    if body_reason:
                        code = 98
                        break
                    time.sleep(min(0.05, max(0, run_deadline - DARWIN.clock_now())))
            stop = request(spec, identity, sequence, ("stop",), 0, observe_only=True, body_code=code)
            if stop is not None:
                sequence = stop["sequence"]
                return finish(spec, identity, sequence, 98, "interrupted", "caller cancellation preceded body cleanup", body_code=code)
            if not DARWIN.drain(identity["coalition_id"], deadline, preserve=identity):
                return finish(spec, identity, sequence, 98, "cleanup", "body descendants did not drain", body_code=code)
            write_state(spec, {"state": "running", "phase": "body-quiescent", "sequence": sequence,
                "identity": identity, "body_code": code, "body_reason": body_reason, "body_detail": body_detail,
                "sealed": False, "body_quiescent": True})
            value = request(spec, identity, sequence, ("normal-after", "fallback", "retire", "stop"), deadline, body_code=code)
            sequence = value["sequence"]
        while True:
            phase = value["phase"]
            if phase in ("normal-after", "fallback"):
                if phase == "normal-after" and normal_done or phase == "fallback" and fallback_done:
                    raise ValueError("guardian phase was already consumed")
                if phase == "normal-after":
                    normal_done = True
                else:
                    fallback_done, failed = True, True
                after, failure, stop_sequence = snapshot(spec, identity, owner, sequence, body_code=code)
                if failure is not None:
                    failed = True
                if stop_sequence is None:
                    try:
                        stop = request(spec, identity, sequence, ("stop",), 0, observe_only=True, body_code=code)
                    except Exception:
                        if failure and failure["reason"] == "cleanup":
                            return finish(spec, identity, sequence, 98, "cleanup", failure["detail"], body_code=code)
                        raise
                    if stop is not None:
                        stop_sequence = stop["sequence"]
                if stop_sequence is not None:
                    sequence = stop_sequence
                    return finish(spec, identity, sequence, 98, "cleanup" if failure and failure["reason"] == "cleanup" else "interrupted",
                        failure["detail"] if failure else "caller cancellation sealed verifier dispatch", body_code=code)
                if not DARWIN.drain(identity["coalition_id"], deadline, preserve=identity):
                    return finish(spec, identity, sequence, 98, "cleanup", "verifier descendants did not drain", body_code=code)
                write_state(spec, {"state": "running", "phase": phase + "-complete", "sequence": sequence,
                    "identity": identity, "after": after, "after_failure": failure, "sealed": False})
                allowed = ("fallback", "retire", "stop") if phase == "normal-after" else ("retire", "stop")
                value = request(spec, identity, sequence, allowed, deadline, body_code=code)
                sequence = value["sequence"]
                continue
            if phase in ("retire", "stop"):
                requested_code = retirement_result(value, code)
                if requested_code != 98 and (not normal_done or failed):
                    raise ValueError("ordinary result requires completed normal verification")
                return finish(spec, identity, sequence, 98 if failed or phase == "stop" else requested_code,
                    value.get("reason"), value.get("detail"), body_code=code)
            raise ValueError("guardian phase cannot dispatch")
    except Exception as error:
        if identity is None:
            write_state(spec, {"state": "failed", "phase": "failed", "sequence": sequence,
                "code": 98, "reason": "setup", "detail": str(error), "sealed": True})
            return 98
        reason = "interrupted" if isinstance(error, InterruptedError) else "timeout" if isinstance(error, TimeoutError) else "setup"
        return finish(spec, identity, sequence, 98, reason, str(error), body_code=code)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(2)
    raise SystemExit(run(sys.argv[1]))
