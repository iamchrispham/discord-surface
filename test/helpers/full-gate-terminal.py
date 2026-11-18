import os
import hashlib
import subprocess
import sys
import tempfile
import threading
import time
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
    scope["_source_write_job_output"] = scope["_write_job_output"]
    accepted = {11: bytearray(), 12: bytearray()}
    calls = []

    def write(fd, payload, deadline=None, logical_state=None):
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


def bounded_namespace():
    scope, owner, accepted, calls = namespace()
    sizes = {11: 0, 12: 0}
    digests = {11: hashlib.sha256(), 12: hashlib.sha256()}
    markers = {11: 0, 12: 0}
    tails = {11: b"", 12: b""}

    def write(fd, payload, deadline=None, logical_state=None):
        observed = tails[fd] + bytes(payload)
        markers[fd] += observed.count(b"APERTURE-GATE-INDETERMINATE reason=")
        tails[fd] = observed[-len(b"APERTURE-GATE-INDETERMINATE reason=") + 1:]
        sizes[fd] += len(payload)
        digests[fd].update(payload)
        return len(payload)

    scope["_write_job_output"] = write
    scope["_bounded_marker_counts"] = markers
    return scope, owner, sizes, digests


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
        scope["_write_job_output"] = scope["_source_write_job_output"]
        require(owner.publish(98) == 98, "blocked delivery passed")
        require(owner.marker_attempted and owner.recovery_staged, "blocked record not independently staged")
        require(b"reason=timeout:" in Path(owner.recovery_path).read_bytes(), "wrong record retained")
        require(os.get_blocking(writer), "descriptor mode was not restored")
    finally:
        os.close(writer)
        os.close(reader)


def phase_reserve():
    scope, owner, accepted, calls = namespace()
    clock = [0.0]
    sleeps = [0]

    def sleep(seconds):
        sleeps[0] += 1
        require(sleeps[0] <= 1000, "phase relay exceeded fixed attempts")
        clock[0] += seconds

    scope["clock_now"] = lambda: clock[0]
    scope["time"] = types.SimpleNamespace(sleep=sleep)
    scope["_read_job_state"] = lambda *args: None
    scope["_write_job_output"] = scope["_source_write_job_output"]
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

        clock[0] = 0
        sleeps[0] = 0
        cancel_event = threading.Event()

        def cancel_during_write(fd, payload, deadline=None, logical_state=None, interrupted=None):
            cancel_event.set()
            return scope["_source_write_job_output"](
                fd, payload, deadline, logical_state, interrupted=interrupted
            )

        scope["_write_job_output"] = cancel_during_write
        state, offset = scope["_wait_job_phase"](
            "unused", None, None, "private", ("ready",), 0, 5, cancel_event, str(path), cursor
        )
        require(state is None and offset == 0, "cancelled phase published a stale state")
        require(cancel_event.is_set() and clock[0] < 0.1, "blocked output delayed phase cancellation")
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


def linux_output(raw, marked=False, multiple_markers=False):
    scope, owner, accepted, calls = namespace()
    scope["clock_now"] = lambda: 0
    scope["capture_snapshot"] = lambda *args, **kwargs: {"snapshot": "same", "budget": 20, "slowest": 1}
    scope["wait_for_owned_children"] = lambda deadline: True
    marker = b"APERTURE-GATE-INDETERMINATE reason=capacity: child\n"
    if multiple_markers:
        marker_payload = marker + b"BETWEEN\n" + marker + b"TAIL\n"
    elif marked:
        marker_payload = marker + b"TAIL\n"
    else:
        marker_payload = b""

    class Process:
        def __init__(self, *args, **kwargs):
            kwargs["stdout"].write(b"OUT\n" + marker_payload)
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
    if multiple_markers and raw == 98:
        expected = b"OUT\nBETWEEN\nTAIL\n" + marker
    elif multiple_markers:
        expected = b"OUT\nBETWEEN\nTAIL\n" + marker + marker
    else:
        expected = b"OUT\nTAIL\n" + marker if marked else b"OUT\n"
    actual = bytes(accepted[11])
    require(actual == expected, f"stdout/candidate progress changed for result {raw}: {actual!r} != {expected!r}")


def linux_multiple_markers():
    for result in (0, 17, 98):
        linux_output(result, multiple_markers=True)


def linux_post_exit_cancel():
    if sys.platform != "linux":
        return
    scope, owner, accepted, calls = namespace()
    phases = []
    interrupted = threading.Event()
    actor = None

    with tempfile.TemporaryDirectory(prefix="terminal-adopted-child-") as actor_root:
        actor_path = Path(actor_root) / "actor-exit"

        class Process:
            def __init__(self, *args, **kwargs):
                nonlocal actor
                kwargs["stdout"].write(b"OUT\n")
                kwargs["stdout"].flush()
                kwargs["stderr"].write(b"ERR_ONCE\n")
                kwargs["stderr"].flush()
                actor_code = (
                    "import pathlib,signal,sys,time\n"
                    "target=pathlib.Path(sys.argv[1])\n"
                    "def stopped(signum, frame):\n"
                    " target.write_text('terminated')\n"
                    " raise SystemExit(0)\n"
                    "signal.signal(signal.SIGTERM, stopped)\n"
                    "time.sleep(8)\n"
                    "target.write_text('self-destructed')\n"
                )
                actor = subprocess.Popen(
                    [sys.executable, "-I", "-c", actor_code, str(actor_path)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )

            def poll(self):
                return 17

            def wait(self):
                return 17

        def expire_drain(deadline):
            interrupted.set()
            return False

        def snapshot_after_cancel(root, environment, phase, deadline, cancel, *, stop_deadline):
            phases.append(phase)
            if phase == "after" and cancel.is_set():
                raise InterruptedError("fixture verifier cancelled before launch")
            return {"snapshot": "same", "budget": 20, "slowest": 1}

        scope["clock_now"] = time.monotonic
        scope["capture_snapshot"] = snapshot_after_cancel
        scope["wait_for_owned_children"] = expire_drain
        scope["subprocess"] = types.SimpleNamespace(Popen=Process, PIPE=-1, TimeoutExpired=TimeoutError)
        receipt = types.SimpleNamespace(path="private-receipt", token="private-token")
        try:
            result = scope["run_supervised"](
                Path.cwd(), ["not-executed"], {"APERTURE_GATE_TIME_LEFT_S": "20"},
                time.monotonic(), receipt, interrupted
            )
            owner.close_captures()
            require(result == 98, "interrupted post-exit drain changed terminal result")
            require(phases == ["before", "after"], "source verification did not take the interrupted path")
            require(actor is not None, "bounded adopted-child actor did not start")
            actor.wait(timeout=10)
            require(actor_path.read_text() == "terminated", "adopted child survived supervisor cleanup")
        finally:
            if actor is not None and actor.poll() is None:
                actor.wait(timeout=10)


def large_publish_memory():
    if sys.platform != "linux":
        return
    try:
        import resource
    except ImportError as error:
        raise AssertionError("Linux memory scenario lacks resource limits") from error
    if not hasattr(resource, "RLIMIT_AS"):
        raise AssertionError("Linux memory scenario lacks RLIMIT_AS")
    try:
        _, hard = resource.getrlimit(resource.RLIMIT_AS)
        resource.setrlimit(resource.RLIMIT_AS, (96 * 1024 * 1024, hard))
    except (OSError, ValueError) as error:
        raise AssertionError("Linux memory scenario could not set RLIMIT_AS") from error
    scope, owner, accepted, calls = namespace()
    capture = owner.add_capture("stdout", replay=False)
    chunk = b"x" * 65536
    for _ in range(2048):
        capture.write(chunk)
    capture_path = capture.name
    owner.close_captures()
    require(owner.publish(0) == 0, "large replay-false capture was not published")
    require(not Path(capture_path).exists(), "large replay-false capture was not retired")


def large_required_files():
    marker = b"APERTURE-GATE-INDETERMINATE reason=capacity: bounded\n"
    stderr_payload = b"e" * (2 * 65536 + 17)
    for result in (0, 17, 98):
        scope, owner, sizes, digests = bounded_namespace()
        stdout_path = Path(tempfile.gettempdir()) / ("terminal-large-stdout-" + str(result))
        stderr_path = Path(tempfile.gettempdir()) / ("terminal-large-stderr-" + str(result))
        stdout_path.write_bytes(marker)
        stderr_path.write_bytes(stderr_payload)
        cursor = {"offset": 0, "verdict": (0, len(marker)), "output_line_start": True}
        try:
            require(scope["_emit_job_stderr"](
                str(stderr_path), str(stdout_path), result, True, cursor, None
            ), "large required output did not stage")
            require(owner.publish(result) == result, "raw result changed during large output publication")
            require(sizes[11] == len(marker), "candidate delivery size changed")
            require(sizes[12] == len(stderr_payload), "stderr delivery size changed")
            require(digests[11].digest() == hashlib.sha256(marker).digest(), "candidate bytes changed")
            require(digests[12].digest() == hashlib.sha256(stderr_payload).digest(), "stderr bytes changed")
            require(not owner.evidence_paths or all(not Path(path).exists() for path in owner.evidence_paths),
                    "large output evidence was not retired")
        finally:
            stdout_path.unlink(missing_ok=True)
            stderr_path.unlink(missing_ok=True)


def expired_range_delivery():
    payload = b"ordinary output\n"
    scope, owner, sizes, digests = bounded_namespace()
    source = Path(tempfile.gettempdir()) / "terminal-expired-range"
    source.write_bytes(payload)
    try:
        require(owner.add_file("stdout", str(source), replay=True), "ordinary range setup failed")
        owner.set_deadline(0)
        scope["clock_now"] = lambda: 1
        require(owner.publish(0) == 0, "expired ordinary range changed raw result")
        require(sizes[11] == len(payload), "expired ordinary range skipped first write")
        require(digests[11].digest() == hashlib.sha256(payload).digest(), "expired ordinary range changed bytes")

        scope, owner, sizes, digests = bounded_namespace()
        marker = b"APERTURE-GATE-INDETERMINATE reason=capacity: expired\n"
        cursor = {"output_line_start": False}
        owner.candidate = marker
        owner.request(None, None, stdout_cursor=cursor, stdout_deadline=0)
        scope["clock_now"] = lambda: 1
        require(owner.publish(98) == 98, "expired candidate changed raw result")
        expected = b"\n" + marker
        require(sizes[11] == len(expected), "expired candidate prefix delivery changed size")
        require(digests[11].digest() == hashlib.sha256(expected).digest(), "expired candidate prefix changed bytes")
    finally:
        source.unlink(missing_ok=True)


def marker_delivery_error():
    scope, owner, accepted, calls = namespace()
    marker = b"APERTURE-GATE-INDETERMINATE reason=cleanup: writer\n"
    cursor = {"output_line_start": True}
    owner.candidate = marker
    owner.request(None, None, stdout_cursor=cursor)

    def failed_writer(*args, **kwargs):
        raise ValueError("controlled writer failure")

    scope["_write_job_output"] = failed_writer
    require(owner.publish(98) == 98, "writer ValueError escaped owner boundary")
    require(owner.marker_attempted and owner.output_complete is False, "writer failure was not sticky")
    require(cursor["verdict_delivery_complete"] is False and cursor["retain_output"] is True,
            "writer failure lost delivery custody flags")
    require(owner.accepted_offsets["verdict"] == 0, "writer failure lost accepted offset")
    require(owner.recovery_path is not None and Path(owner.recovery_path).exists(),
            "writer failure discarded recovery evidence")


def darwin_output(mode):
    large = mode == "large"
    if large:
        scope, owner, sizes, digests = bounded_namespace()
        accepted = None
    else:
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

    large_marker = b"APERTURE-GATE-INDETERMINATE reason=capacity: child\n"
    large_stdout = b"b" * (2 * 65536 + 17) + b"\n" + large_marker + b"TAIL\n"
    large_stderr = b"s" * (2 * 65536 + 23)

    def digest_file(path):
        digest = hashlib.sha256()
        size = 0
        with open(path, "rb") as handle:
            while True:
                payload = handle.read(65536)
                if not payload:
                    break
                size += len(payload)
                digest.update(payload)
        return size, digest.digest()

    class Cleanup:
        def which(self, name):
            return "fake-launchctl"

        def rmtree(self, path):
            if large:
                stderr = next(row for row in owner.outputs if row["name"] == "stderr")
                stdout = next(row for row in owner.outputs if row["name"] == "stdout")
                live_prefix = owner.cursor.get("offset", 0)
                require(live_prefix <= len(large_stdout), "large Darwin live cursor exceeded source")
                expected_suffix = large_stdout[live_prefix:]
                require(digest_file(stderr["path"]) == (len(large_stderr), hashlib.sha256(large_stderr).digest()),
                        "large Darwin stderr was not staged before retirement")
                require(digest_file(stdout["path"]) == (len(expected_suffix), hashlib.sha256(expected_suffix).digest()),
                        "large Darwin stdout suffix was not staged before retirement")
                shutil.rmtree(path)
                return
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
        Path(allocations[-1], "stderr.log").write_bytes(large_stderr if large else b"ERR_ONCE\n")
        Path(allocations[-1], "stdout.log").write_bytes(
            large_stdout if large else b"BOOT_OUT\nAPERTURE-GATE-INDETERMINATE reason=capacity: child\nTAIL\n"
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
    if large:
        ordinary_stdout = large_stdout.replace(large_marker, b"", 1)
        outer_marker = ("APERTURE-GATE-INDETERMINATE reason=" + str(owner.reason) + ": "
                        + str(owner.detail or owner.reason) + "\n").encode()
        expected_stdout = ordinary_stdout + outer_marker
        require(sizes[11] == len(expected_stdout), "large Darwin stdout size changed")
        require(sizes[12] == len(large_stderr), "large Darwin stderr size changed")
        require(digests[11].digest() == hashlib.sha256(expected_stdout).digest(), "large Darwin stdout changed")
        require(digests[12].digest() == hashlib.sha256(large_stderr).digest(), "large Darwin stderr changed")
        require(scope["_bounded_marker_counts"][11] == 1, "large Darwin output did not publish one outer marker")
        require(all(not Path(path).exists() for path in owner.evidence_paths),
                "large Darwin evidence was not retired")
        return
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
        elif scenario == "large-publish-memory":
            large_publish_memory()
        elif scenario == "large-required-files":
            large_required_files()
        elif scenario == "expired-range-delivery":
            expired_range_delivery()
        elif scenario == "marker-delivery-error":
            marker_delivery_error()
        elif scenario == "linux-multiple-markers":
            linux_multiple_markers()
        elif scenario == "linux-post-exit-cancel":
            linux_post_exit_cancel()
        elif scenario == "linux-multiple-markers":
            linux_multiple_markers()
        elif scenario == "linux-post-exit-cancel":
            linux_post_exit_cancel()
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
