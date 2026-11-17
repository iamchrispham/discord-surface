import os
import sys
import tempfile
import threading
import types
from pathlib import Path


source_path = Path(sys.argv[1])
scenario = sys.argv[2]
source = source_path.read_text()


def require(value, message):
    if not value:
        raise AssertionError(message)


def namespace():
    scope = {"__file__": str(source_path), "__name__": "terminal_owner_test"}
    exec(compile(source, str(source_path), "exec"), scope)
    accepted = {11: bytearray(), 12: bytearray()}
    calls = []

    def write(fd, payload, deadline=None):
        calls.append((fd, bytes(payload)))
        accepted[fd].extend(payload)
        return len(payload)

    scope["sys"] = types.SimpleNamespace(
        platform="linux",
        executable=sys.executable,
        stdout=types.SimpleNamespace(fileno=lambda: 11),
        stderr=types.SimpleNamespace(fileno=lambda: 12),
    )
    scope["_write_job_output"] = write
    owner = scope["TerminalOutput"]()
    scope["_ACTIVE_TERMINAL_OUTPUT"] = owner
    return scope, owner, accepted, calls


def reason_order():
    for output_first in (False, True):
        for retirement in (False, True):
            scope, owner, accepted, calls = namespace()
            if output_first:
                owner.fail_output("required stderr unavailable")
            owner.request("timeout", "primary timeout")
            if not output_first:
                owner.fail_output("required stderr unavailable")
            if retirement:
                owner.fail_retirement("required receipt removal failed")
            require(owner.publish(0) == 98, "uncertainty returned a result")
            marker = bytes(accepted[11])
            expected = b"cleanup" if retirement else b"timeout"
            require(b"reason=" + expected + b":" in marker, "arrival order changed precedence")
            require(b"primary timeout" in marker and b"required stderr unavailable" in marker,
                    "primary diagnostic or output uncertainty was lost")
            require(marker.count(b"APERTURE-GATE-INDETERMINATE") == 1, "multiple publications")
            for path in owner.evidence_paths:
                require(Path(path).exists() and str(path).encode() in marker, "retained evidence unnamed")


def required_hold():
    scope, owner, accepted, calls = namespace()
    cursor = {"offset": 0, "source_line_start": True, "output_line_start": True, "retain_output": True}
    owner.request(None, None, stdout_cursor=cursor)
    capture = owner.add_capture("stderr")
    capture.write(b"HELD\n")
    owner.close_captures()
    require(owner.publish(0) == 98, "required prior hold certified raw success")
    require(cursor["retain_output"] and Path(capture.name).exists(), "required evidence was deleted")
    require(b"reason=cleanup:" in accepted[11], "required hold lacked uncertainty")


def replacement_failure():
    scope, owner, accepted, calls = namespace()
    require(owner.prepare_recovery() and owner.stage_recovery(b"PRIOR_VALID\n"), "initial record not staged")
    original = Path(owner.recovery_path).read_bytes()

    class FailedSync:
        def __getattr__(self, name):
            return getattr(os, name)

        def fsync(self, descriptor):
            raise OSError("controlled record sync failure")

    scope["os"] = FailedSync()
    owner.request("timeout", "primary timeout")
    require(owner.publish(98) == 98, "failed replacement passed")
    require(Path(owner.recovery_path).read_bytes() == original, "failed replacement destroyed prior record")
    require(b"reason=timeout:" in accepted[11] and b"record sync failure" in accepted[11],
            "usable channel did not receive the applicable storage refusal")
    require(len(calls) == 1, "replacement failure entered another publisher")
    require(not owner.recovery_staged, "failed selected record was reported staged")
    require(all(Path(path).exists() for path in owner.evidence_paths), "replacement evidence discarded")


def blocked_delivery():
    scope, owner, accepted, calls = namespace()
    owner.request("timeout", "primary timeout", stdout_deadline=10)
    reader, writer = os.pipe()
    try:
        os.set_blocking(writer, False)
        full = False
        for _ in range(128):
            try:
                os.write(writer, b"x" * 65536)
            except BlockingIOError:
                full = True
                break
        require(full, "bounded pipe fill did not reach pressure")
        os.set_blocking(writer, True)
        scope["sys"].stdout = types.SimpleNamespace(fileno=lambda: writer)
        scope["clock_now"] = lambda: 10
        scope["time"] = types.SimpleNamespace(sleep=lambda seconds: require(False, "expired writer slept"))
        actual = {"__file__": str(source_path), "__name__": "writer_source"}
        exec(compile(source, str(source_path), "exec"), actual)
        scope["_write_job_output"] = types.FunctionType(
            actual["_write_job_output"].__code__, scope
        )
        require(owner.publish(98) == 98, "blocked delivery passed")
        require(owner.marker_attempted and owner.recovery_staged, "blocked record not independently staged")
        require(b"reason=timeout:" in Path(owner.recovery_path).read_bytes(), "wrong record retained")
        require(os.get_blocking(writer), "descriptor mode was not restored")
    finally:
        os.close(writer)
        os.close(reader)


def phase_reserve():
    scope, owner, accepted, calls = namespace()
    actual = {"__file__": str(source_path), "__name__": "phase_source"}
    exec(compile(source, str(source_path), "exec"), actual)
    clock = [0.0]
    sleeps = [0]

    def sleep(seconds):
        sleeps[0] += 1
        require(sleeps[0] <= 1000, "phase relay exceeded fixed attempts")
        clock[0] += seconds

    scope["clock_now"] = lambda: clock[0]
    scope["time"] = types.SimpleNamespace(sleep=sleep)
    scope["_read_job_state"] = lambda *args: None
    scope["_write_job_output"] = types.FunctionType(actual["_write_job_output"].__code__, scope)
    owner.set_deadline(10)
    reader, writer = os.pipe()
    try:
        os.set_blocking(writer, False)
        full = False
        for _ in range(128):
            try:
                os.write(writer, b"x" * 65536)
            except BlockingIOError:
                full = True
                break
        require(full, "bounded pipe fill did not reach pressure")
        scope["sys"].stdout = types.SimpleNamespace(fileno=lambda: writer)
        path = Path(tempfile.gettempdir()) / "phase-stdout"
        path.write_bytes(b"READY\n")
        cursor = {"offset": 0, "source_line_start": True, "output_line_start": True}
        state, offset = scope["_wait_job_phase"](
            "unused", None, None, "private", ("ready",), 0, 5, threading.Event(), str(path), cursor
        )
        require(state is None and offset == 0 and clock[0] == 5, "phase consumed cleanup reserve")
        require(owner.deadline == 10, "operation bound replaced terminal bound")
    finally:
        os.close(writer)
        os.close(reader)


def public_finalizers(mode):
    scope, owner, accepted, calls = namespace()
    created = []
    original = scope["TerminalOutput"]

    def create():
        selected = original()
        created.append(selected)
        return selected

    scope["TerminalOutput"] = create
    clock = [10]
    scope["clock_now"] = lambda: clock[0]
    events = []
    prior = object()

    def handler(number, value):
        if value is prior and mode == "handler":
            raise OSError("controlled handler restoration failed")
        return prior

    scope["signal"] = types.SimpleNamespace(SIGINT=2, SIGTERM=15, SIGHUP=1, signal=handler)

    class Environment:
        environ = {"APERTURE_GATE_TIME_LEFT_S": "12"}

        def __getattr__(self, name):
            return getattr(os, name)

    scope["os"] = Environment()

    class Storage:
        def __getattr__(self, name):
            return getattr(tempfile, name)

        def mkstemp(self, **kwargs):
            if mode == "creation":
                raise OSError("controlled recovery creation failed")
            if mode == "clock":
                clock[0] += 3
            return tempfile.mkstemp(**kwargs)

    scope["tempfile"] = Storage()
    scope["establish_reaping_contract"] = lambda: events.append("reaping")
    scope["enable_subreaper"] = lambda: None

    class Receipt:
        def __init__(self):
            events.append("receipt")
            if mode == "clock":
                path = created[-1].recovery_path
                require(path is not None and Path(path).exists(), "receipt preceded recovery custody")

        def close(self):
            if mode == "receipt":
                raise OSError("controlled receipt removal failed")

    scope["SupervisorReceipt"] = Receipt

    def body(root, command, environment, started, receipt, interrupted):
        events.append("body")
        selected = created[-1]
        if mode in ("receipt", "handler"):
            selected.set_deadline(started + 12)
        else:
            require(started == 10 and selected.deadline == 22, "preparation restarted caller clock")
        if mode == "clock":
            require(clock[0] == 13, "preparation time was not observed")
            return 17
        selected.request("timeout", "primary timeout")
        return 98

    scope["run_supervised"] = body
    code = scope["run"](["--", "not-executed"])
    marker = bytes(accepted[11])
    if mode == "creation":
        require(events == [] and code == 98, "storage failure started productive work")
        require(b"recovery creation failed" in marker, "creation failure skipped usable refusal channel")
    elif mode == "clock":
        require(code == 17 and clock[0] == 13 and not marker, "clock/result changed")
    else:
        require(code == 98 and b"reason=cleanup:" in marker, "required finalizer lost cleanup precedence")
        require(b"primary timeout" in marker and mode.encode() in marker, "finalizer diagnostic lost")


def linux_output(raw, marked=False):
    scope, owner, accepted, calls = namespace()
    scope["clock_now"] = lambda: 0
    scope["capture_snapshot"] = lambda *args, **kwargs: {"snapshot": "same", "budget": 20, "slowest": 1}
    scope["wait_for_owned_children"] = lambda deadline: True
    marker = b"APERTURE-GATE-INDETERMINATE reason=capacity: child\n"

    class Process:
        def __init__(self, *args, **kwargs):
            kwargs["stdout"].write(b"OUT\n" + (marker + b"TAIL\n" if marked else b""))
            kwargs["stdout"].flush()
            kwargs["stderr"].write(b"ERR_ONCE\n")
            kwargs["stderr"].flush()

        def poll(self):
            return raw

        def wait(self):
            return raw

    scope["subprocess"] = types.SimpleNamespace(Popen=Process)
    receipt = types.SimpleNamespace(path="private-receipt", token="private-token")
    result = scope["run_supervised"](
        Path.cwd(), ["not-executed"], {"APERTURE_GATE_TIME_LEFT_S": "20"}, 0, receipt, threading.Event()
    )
    owner.close_captures()
    require(owner.publish(result) == raw, "coordinator changed raw result")
    require(bytes(accepted[12]) == b"ERR_ONCE\n", "ordinary stderr replayed more than once")
    expected = b"OUT\nTAIL\n" + marker if marked else b"OUT\n"
    require(bytes(accepted[11]) == expected, "stdout/candidate progress duplicated or lost")


def darwin_output(mode):
    scope, owner, accepted, calls = namespace()
    scope["clock_now"] = lambda: 0
    scope["capture_snapshot"] = lambda *args, **kwargs: {"snapshot": "same", "budget": 20, "slowest": 1}
    scope["load_darwin_owner"] = lambda: types.SimpleNamespace(
        CLOCK_CONTRACT="fixture-clock", joined_identity=lambda pid: {"pid": pid, "coalition_id": "private"}
    )
    allocations = []

    class Storage:
        def __getattr__(self, name):
            return getattr(tempfile, name)

        def mkdtemp(self, **kwargs):
            path = tempfile.mkdtemp(prefix="darwin-unit-")
            allocations.append(path)
            return path

    scope["tempfile"] = Storage()
    import shutil

    class Cleanup:
        def which(self, name):
            return "fake-launchctl"

        def rmtree(self, path):
            staged = [Path(row["path"]).read_bytes() for row in owner.outputs if row["name"] == "stderr"]
            require(b"ERR_ONCE\n" in staged, "retirement preceded required stderr custody")
            stdout = bytes(accepted[11]) + b"".join(
                Path(row["path"]).read_bytes() for row in owner.outputs if row["name"] == "stdout"
            )
            require(b"BOOT_OUT\n" in stdout and b"TAIL\n" in stdout,
                    "retirement preceded required stdout custody")
            shutil.rmtree(path)

    scope["shutil"] = Cleanup()
    scope["_service_state"] = lambda *args: {"present": False}

    def bootstrap(*args):
        Path(allocations[-1], "stderr.log").write_bytes(b"ERR_ONCE\n")
        Path(allocations[-1], "stdout.log").write_bytes(
            b"BOOT_OUT\nAPERTURE-GATE-INDETERMINATE reason=capacity: child\nTAIL\n"
        )
        return types.SimpleNamespace(returncode=1 if mode == "bootstrap" else 0, stdout="", stderr="bootstrap refused")

    scope["_launchctl"] = bootstrap
    scope["_wait_job_phase"] = lambda *args, **kwargs: (_ for _ in ()).throw(OSError("controlled phase failure"))

    def cleaned(*args, **kwargs):
        state = kwargs.get("terminal_state")
        if state is not None:
            state.update(sealed=True, quiescent=True, code=98, reason="setup")
        return True

    scope["_darwin_cleanup"] = cleaned
    receipt = types.SimpleNamespace(path="private-receipt", token="private-token")
    result = scope["run_darwin_supervised"](
        Path.cwd(), ["not-executed"], {"APERTURE_GATE_TIME_LEFT_S": "20"}, 0, receipt, threading.Event()
    )
    owner.close_captures()
    require(owner.publish(result) == 98, "Darwin refusal passed")
    require(bytes(accepted[12]) == b"ERR_ONCE\n", "exception/bootstrap stderr was lost or duplicated")
    require(bytes(accepted[11]).startswith(b"BOOT_OUT\nTAIL\n"), "Darwin ordinary stdout was lost or duplicated")
    require(b"reason=capacity: child" not in accepted[11], "superseded child marker was published")
    require(all(not Path(path).exists() for path in allocations), "known-drained allocation not retired")
    require(bytes(accepted[11]).count(b"APERTURE-GATE-INDETERMINATE") == 1, "Darwin published twice")


with tempfile.TemporaryDirectory(prefix="gate-terminal-unit-") as root:
    previous = tempfile.tempdir
    tempfile.tempdir = root
    try:
        if scenario == "reason-order":
            reason_order()
        elif scenario == "required-hold":
            required_hold()
        elif scenario == "replacement-failure":
            replacement_failure()
        elif scenario == "blocked-delivery":
            blocked_delivery()
        elif scenario == "phase-reserve":
            phase_reserve()
        elif scenario.startswith("finalizer-"):
            public_finalizers(scenario.removeprefix("finalizer-"))
        elif scenario.startswith("linux-"):
            value = scenario.removeprefix("linux-")
            linux_output(98 if value == "marked" else int(value), value == "marked")
        elif scenario.startswith("darwin-"):
            darwin_output(scenario.removeprefix("darwin-"))
        else:
            raise AssertionError("unknown owner scenario")
    finally:
        tempfile.tempdir = previous
