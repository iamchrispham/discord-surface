import errno
import os
import hashlib
import shutil
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

    def write(fd, payload, deadline=None, logical_state=None, *, interrupted=None):
        if interrupted is not None and interrupted.is_set():
            return 0
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

    def write(fd, payload, deadline=None, logical_state=None, *, interrupted=None):
        if interrupted is not None and interrupted.is_set():
            return 0
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


def retire_fixture_allocation(path, _deadline):
    shutil.rmtree(path)


def linux_output(raw, marked=False, multiple_markers=False, marker_payload_override=None,
                 expected_output=None, expected_no_verdict=None, late_newline=False):
    scope, owner, accepted, calls = namespace()
    scope["_remove_gate_scratch"] = retire_fixture_allocation
    scope["clock_now"] = lambda: 0
    scope["capture_snapshot"] = lambda *args, **kwargs: {"snapshot": "same", "budget": 20, "slowest": 1}
    marker = b"APERTURE-GATE-INDETERMINATE reason=capacity: child\n"
    if marker_payload_override is not None:
        marker_payload = marker_payload_override
    elif multiple_markers:
        marker_payload = marker + b"BETWEEN\n" + marker + b"TAIL\n"
    elif marked:
        marker_payload = marker[:-1] + (b"" if late_newline else b"\nTAIL\n")
    else:
        marker_payload = b""
    stdout_capture = None

    class Process:
        def __init__(self, *args, **kwargs):
            nonlocal stdout_capture
            stdout_capture = kwargs["stdout"]
            kwargs["stdout"].write(b"OUT\n" + marker_payload)
            kwargs["stdout"].flush()
            kwargs["stderr"].write(b"ERR_ONCE\n")
            kwargs["stderr"].flush()

        def poll(self):
            return raw

        def wait(self):
            return raw

    scope["subprocess"] = types.SimpleNamespace(Popen=Process)
    suffix_appended = False

    def wait_for_owned_children(deadline):
        nonlocal suffix_appended
        if late_newline and not suffix_appended:
            stdout_capture.write(b"\nTAIL\n")
            stdout_capture.flush()
            suffix_appended = True
        return True

    scope["wait_for_owned_children"] = wait_for_owned_children
    receipt = types.SimpleNamespace(path="private-receipt", token="private-token")
    result = scope["run_supervised"](
        Path.cwd(), ["not-executed"], {"APERTURE_GATE_TIME_LEFT_S": "20"}, 0, receipt, threading.Event()
    )
    owner.close_captures()
    require(owner.publish(result) == raw, "coordinator changed raw result")
    require(bytes(accepted[12]) == b"ERR_ONCE\n", "ordinary stderr replayed more than once")
    if expected_output is not None:
        expected = expected_no_verdict if raw == 98 and expected_no_verdict is not None else expected_output
    elif multiple_markers and raw == 98:
        expected = b"OUT\nBETWEEN\nTAIL\n" + marker
    elif multiple_markers:
        expected = b"OUT\nBETWEEN\nTAIL\n" + marker + marker
    else:
        expected = b"OUT\nTAIL\n" + marker if marked else b"OUT\n"
    actual = bytes(accepted[11])
    require(actual == expected, f"stdout/candidate progress changed for result {raw}: {actual!r} != {expected!r}")
    return owner


def linux_multiple_markers():
    for result in (0, 17, 98):
        linux_output(result, multiple_markers=True)
    marker = b"APERTURE-GATE-INDETERMINATE reason=capacity: child\n"
    for count in (1, 8, 32):
        payload = marker * count
        owner = linux_output(
            17,
            marker_payload_override=payload,
            expected_output=b"OUT\n" + payload,
            expected_no_verdict=b"OUT\n" + marker,
        )
        staged = [row for row in owner.outputs if "range_count" in row]
        require(len(staged) == 1 and staged[0]["range_count"] == count,
                "marker replay staging grew with the marker count")
    owner = linux_output(
        98,
        marker_payload_override=marker * 32,
        expected_output=b"OUT\n" + marker * 32,
        expected_no_verdict=b"OUT\n" + marker,
    )
    require(sum(row["name"] == "candidate" for row in owner.outputs) == 1,
            "no-verdict candidate selection grew with the marker count")
    owner = linux_output(17, marker_payload_override=b"", expected_output=b"OUT\n")
    require(not any("range_count" in row for row in owner.outputs),
            "marker-free output created an extra stage")

    chunk_prefix_size = 65536 - 4 - len(marker) // 2
    chunk_prefix = b"x" * (chunk_prefix_size - 1) + b"\n"
    linux_output(
        17,
        marker_payload_override=chunk_prefix + marker + b"TAIL\n",
        expected_output=b"OUT\n" + chunk_prefix + b"TAIL\n" + marker,
    )
    long_marker = b"APERTURE-GATE-INDETERMINATE reason=" + b"x" * (2 * 65536) + b"\n"
    linux_output(
        17,
        marker_payload_override=long_marker + b"TAIL\n",
        expected_output=b"OUT\nTAIL\n" + long_marker,
    )

    def replay_history(split_marker):
        scope, owner, accepted, calls = namespace()
        scope["clock_now"] = lambda: 0
        scope["_ACTIVE_TERMINAL_OUTPUT"] = owner
        stdout = owner.add_capture("stdout", replay=False)
        stderr = owner.add_capture("stderr", replay=False)
        stderr.write(b"ERR_ONCE\n")
        stdout.write(b"PREFIX\n")
        if split_marker:
            stdout.write(marker[:-1])
            stdout.flush()
            cursor = {"offset": 0, "source_line_start": True, "output_line_start": True}
            scope["_stream_stdout"](stdout.name, cursor)
            scope["_stream_stdout"](stdout.name, cursor)
            stdout.write(b"\nTAIL\n")
        else:
            stdout.write(marker + b"TAIL\n")
            cursor = {"offset": 0, "source_line_start": True, "output_line_start": True}
        stdout.flush()
        for _ in range(5):
            previous = cursor["offset"]
            scope["_stream_stdout"](stdout.name, cursor, final=True)
            if cursor["offset"] == previous and cursor["offset"] == Path(stdout.name).stat().st_size:
                break
        stderr.flush()
        require(scope["_emit_job_stderr"](
            stderr.name, stdout.name, 17, True, cursor, None
        ), "diverging-prefix output did not stage")
        require(owner.publish(17) == 17, "diverging-prefix result changed")
        return bytes(accepted[11]), cursor

    complete_history, complete_cursor = replay_history(False)
    late_history, late_cursor = replay_history(True)
    expected_history = b"PREFIX\nTAIL\n" + marker
    require(complete_history == expected_history and late_history == expected_history,
            "diverging prefixes duplicated or skipped accepted output")
    require((complete_cursor["offset"], complete_cursor["source_line_start"],
             complete_cursor["output_line_start"], complete_cursor["verdict"])
            == (late_cursor["offset"], late_cursor["source_line_start"],
                late_cursor["output_line_start"], late_cursor["verdict"]),
            "late newline did not converge on the same accepted cursor")
    linux_output(17, marked=True, late_newline=True,
                 expected_output=b"OUT\nTAIL\n" + marker)
    darwin_output("late-newline")

    scope, owner, accepted, calls = namespace()
    capture = owner.add_capture("stdout")
    capture.write(marker)
    capture.flush()
    scope["_ACTIVE_TERMINAL_OUTPUT"] = owner
    cursor = {"offset": 0, "source_line_start": True, "output_line_start": True}
    original_os = scope["os"]
    append_attempts = [0]

    class ShortJournalWrite:
        def __getattr__(self, name):
            return getattr(original_os, name)

        def write(self, descriptor, payload):
            if len(payload) == 16:
                append_attempts[0] += 1
                return original_os.write(descriptor, payload[:8])
            return original_os.write(descriptor, payload)

    scope["os"] = ShortJournalWrite()
    scope["_stream_stdout"](capture.name, cursor, final=True)
    require(cursor["offset"] == 0 and cursor["retain_output"],
            "partial journal append advanced the stdout cursor")
    require(owner.output_complete is False and owner.verdict_range_count == 0,
            "partial journal append was accepted")
    journal_path = owner.verdict_journal_path
    require(journal_path is not None and Path(journal_path).stat().st_size == 8,
            "partial journal evidence was discarded")
    scope["_stream_stdout"](capture.name, cursor, final=True)
    require(append_attempts[0] == 1 and cursor["offset"] == 0,
            "ambiguous journal append was retried or skipped")
    owner.close_captures()
    require(Path(capture.name).exists(), "partial append discarded original capture")

    scope, owner, accepted, calls = namespace()
    stdout = owner.add_capture("stdout")
    stdout.write(marker)
    stdout.flush()
    stderr = owner.add_capture("stderr")
    stderr.write(b"ERR_ONCE\n")
    stderr.flush()
    require(owner.record_verdict_range(0, len(marker)), "stage-failure range setup failed")
    scope["_ACTIVE_TERMINAL_OUTPUT"] = owner
    cursor = {"offset": len(marker), "verdict": (0, len(marker)), "output_line_start": True}

    class FailedStageSync:
        def __getattr__(self, name):
            return getattr(original_os, name)

        def fsync(self, descriptor):
            raise OSError("injected stage sync failure")

    scope["os"] = FailedStageSync()
    require(not scope["_emit_job_stderr"](
        stderr.name, stdout.name, 17, True, cursor, None
    ), "failed combined stage was accepted")
    require(cursor["retain_output"] and owner.output_complete is False,
            "failed combined stage did not poison output custody")
    staged = [row for row in owner.outputs if "range_count" in row]
    require(len(staged) == 1 and Path(staged[0]["path"]).exists(),
            "failed combined stage evidence was discarded")
    require(Path(stdout.name).exists() and Path(owner.verdict_journal_path).exists(),
            "failed combined stage lost its source evidence")
    require(bytes(accepted[11]) == b"", "failed combined stage published duplicate bytes")
    owner.close_captures()


def linux_journal_short_write():
    scope, owner, _, _ = namespace()
    scope["_remove_gate_scratch"] = retire_fixture_allocation
    now = 0
    phases = []
    polls = []
    appends = 0
    marker = b"APERTURE-GATE-INDETERMINATE reason=capacity: "
    original_os = scope["os"]
    stream = scope["_stream_stdout"]

    class ShortJournalWrite:
        def __getattr__(self, name):
            return getattr(original_os, name)

        def write(self, descriptor, payload):
            nonlocal appends
            if len(payload) == 16:
                appends += 1
                return original_os.write(descriptor, payload[:8])
            return original_os.write(descriptor, payload)

    class ExitedBody:
        def __init__(self, *args, **kwargs):
            self.__class__.scratch = Path(kwargs["env"]["DISCORD_SURFACE_GATE_SCRATCH"])
            capture = kwargs["stdout"]
            self.__class__.capture = Path(capture.name)
            capture.write(b"OUT\n" + marker + b"x" * 65536 + b"\n")
            capture.flush()

        def poll(self):
            return 17

        def wait(self):
            return 17

    def sleep(seconds):
        nonlocal now
        now += seconds

    def snapshot(root, environment, phase, deadline, *args, **kwargs):
        phases.append((phase, now))
        if now >= deadline:
            raise TimeoutError("source verification reserve exhausted")
        return {"snapshot": "same", "budget": 20, "slowest": 1}

    def observe_stream(path, cursor, *args, **kwargs):
        polls.append((cursor["offset"], not owner.output_complete))
        return stream(path, cursor, *args, **kwargs)

    scope.update(os=ShortJournalWrite(), subprocess=types.SimpleNamespace(Popen=ExitedBody),
                 clock_now=lambda: now, time=types.SimpleNamespace(sleep=sleep), POLL_SECONDS=1,
                 capture_snapshot=snapshot, wait_for_owned_children=lambda deadline: True,
                 _stream_stdout=observe_stream)
    try:
        result = scope["run_supervised"](
            Path.cwd(), ["not-executed"], {"APERTURE_GATE_TIME_LEFT_S": "20"}, 0,
            types.SimpleNamespace(path="private-receipt", token="private-token"), threading.Event()
        )
    finally:
        owner.close_captures()
    require(owner.publish(result) == 98 and appends == 1 and owner.verdict_range_count == 0,
            "short append was accepted or retried")
    require(phases == [("before", 0), ("after", 0)] and not any(poisoned for _, poisoned in polls),
            f"short append consumed cleanup time or retried a poisoned cursor: {phases}, {len(polls)} polls")
    require(owner.cursor["offset"] == len(b"OUT\n"), "split marker lost its accepted boundary")
    require(not ExitedBody.scratch.exists(), "drained Linux allocation was retained")
    require(ExitedBody.capture.exists() and Path(owner.verdict_journal_path).stat().st_size == 8,
            "short append lost the original capture or partial journal")


def linux_adopted_child_drain():
    def setup():
        scope, _, _, _ = namespace()
        state = {"adopted": False}
        now = [0]

        class ReapingOS:
            WNOHANG = os.WNOHANG

            def __getattr__(self, name):
                return getattr(os, name)

            def waitpid(self, pid, options):
                require(options == os.WNOHANG, "child drain used a blocking wait")
                if pid == -1:
                    if not state["adopted"]:
                        state["adopted"] = True
                        return 101, 0
                    return 0, 0
                if pid == 101:
                    state["adopted"] = True
                    return 101, 0
                if pid == 202:
                    return 0, 0
                raise ChildProcessError

        scope.update(
            os=ReapingOS(),
            direct_children=lambda: [202] if state["adopted"] else [101],
            clock_now=lambda: now[0],
            time=types.SimpleNamespace(sleep=lambda seconds: now.__setitem__(0, now[0] + seconds)),
            POLL_SECONDS=1,
        )
        return scope, state, now

    scope, _, _ = setup()
    require(scope["live_owned_children"]() == [202],
            "drain accepted the first reap without seeing its adopted writer")

    scope, _, now = setup()
    require(scope["wait_for_owned_children"](1) is False,
            "wait reported drain while the adopted writer was live")
    require(now[0] == 1, "adopted writer wait exceeded its caller deadline")

    empty, _, _, _ = namespace()

    class NoChildrenOS:
        WNOHANG = os.WNOHANG

        def __getattr__(self, name):
            return getattr(os, name)

        def waitpid(self, _pid, _options):
            raise ChildProcessError

    empty.update(os=NoChildrenOS(), direct_children=lambda: [], clock_now=lambda: 0,
                 time=types.SimpleNamespace(sleep=lambda _seconds: None), POLL_SECONDS=1)
    require(empty["live_owned_children"]() == [], "an empty child tree did not drain")
    require(empty["wait_for_owned_children"](1) is True, "an empty child tree lost its clean result")

    unavailable, _, _, _ = namespace()

    class ChildStillExistsOS:
        WNOHANG = os.WNOHANG

        def __getattr__(self, name):
            return getattr(os, name)

        def waitpid(self, _pid, _options):
            return 0, 0

    def unreadable_children():
        raise OSError("injected child ownership read failure")

    unavailable.update(os=ChildStillExistsOS(), direct_children=unreadable_children,
                       clock_now=lambda: 0, time=types.SimpleNamespace(sleep=lambda _seconds: None),
                       POLL_SECONDS=1)
    try:
        unavailable["wait_for_owned_children"](1)
    except OSError:
        pass
    else:
        raise AssertionError("unknown child ownership was accepted as drained")


def linux_final_relay_reserve(*, permanent=False):
    scope, owner, _, _ = namespace()
    scope["_remove_gate_scratch"] = retire_fixture_allocation
    now = [0]
    phases = []
    pipe_output = bytearray()
    write_times = []
    stdout_data = b"OUT\nTAIL\n"
    original_os = os

    class BackpressuredOS:
        blocking = True

        def __getattr__(self, name):
            return getattr(original_os, name)

        def get_blocking(self, descriptor):
            require(descriptor == 11, "final relay inspected the wrong descriptor")
            return self.blocking

        def set_blocking(self, descriptor, value):
            require(descriptor == 11, "final relay changed the wrong descriptor")
            self.blocking = value

        def write(self, descriptor, payload):
            require(descriptor == 11, "final relay wrote to the wrong descriptor")
            write_times.append(now[0])
            if permanent:
                if len(write_times) == 1:
                    pipe_output.extend(payload[:4])
                    return 4
                raise BrokenPipeError(errno.EPIPE, "stdout closed after accepting a prefix")
            if now[0] < 19:
                raise BlockingIOError("stdout becomes writable after the verification reserve")
            pipe_output.extend(payload)
            return len(payload)

    class ExitedBody:
        def __init__(self, *args, **kwargs):
            self.scratch = Path(kwargs["env"]["DISCORD_SURFACE_GATE_SCRATCH"])
            self.capture = Path(kwargs["stdout"].name)
            kwargs["stdout"].write(stdout_data)
            kwargs["stdout"].flush()
            kwargs["stderr"].write(b"")
            kwargs["stderr"].flush()

        def poll(self):
            return 0

        def wait(self):
            return 0

    def sleep(seconds):
        now[0] += seconds

    def snapshot(_root, _environment, phase, deadline, _interrupted, *, stop_deadline):
        phases.append((phase, now[0]))
        if phase == "after" and now[0] >= stop_deadline - scope["SNAPSHOT_STOP_RESERVE_SECONDS"]:
            raise TimeoutError("source verification reserve exhausted")
        return {"snapshot": "same", "budget": 20, "slowest": 1}

    scope.update(os=BackpressuredOS(), _write_job_output=scope["_source_write_job_output"],
                 subprocess=types.SimpleNamespace(Popen=ExitedBody),
                 clock_now=lambda: now[0], time=types.SimpleNamespace(sleep=sleep), POLL_SECONDS=1,
                 capture_snapshot=snapshot, wait_for_owned_children=lambda _deadline: True)
    try:
        result = scope["run_supervised"](
            Path.cwd(), ["not-executed"], {"APERTURE_GATE_TIME_LEFT_S": "20"}, 0,
            types.SimpleNamespace(path="private-receipt", token="private-token"), threading.Event()
        )
    finally:
        owner.close_captures()

    cutoff = scope["CLEANUP_RESERVE_SECONDS"]
    reserve = scope["SNAPSHOT_STOP_RESERVE_SECONDS"]
    require(phases == [("before", 0), ("after", now[0])], "source snapshots did not bracket the run")
    require(now[0] < 20 - reserve, "final stdout relay consumed the source verification reserve")
    require(not any(value >= 20 - cutoff for value in write_times),
            "final stdout relay attempted delivery past its verification cutoff")
    expected_output = stdout_data[:4] if permanent else b""
    if permanent:
        require(phases[-1] == ("after", 0) and write_times == [0, 0],
                "permanent stdout failure delayed source verification or retried the closed pipe")
    require(result == 0 and pipe_output == expected_output, "stdout relay lost the accepted prefix or changed the body result")
    require(owner.cursor["offset"] == len(expected_output) and owner.output_complete is False,
            "final relay did not preserve its last accepted offset")
    capture = next(output["path"] for output in owner.outputs if output["name"] == "stdout")
    require(Path(capture).exists() and Path(capture).read_bytes() == stdout_data,
            "final relay discarded the unread stdout capture")


def linux_verifier_cleanup(*, setup_error=False):
    scope, owner, _, _ = namespace()
    allocations = []

    class ExitedBody:
        def __init__(self, *args, **kwargs):
            allocations.append(Path(kwargs["env"]["DISCORD_SURFACE_GATE_SCRATCH"]))
            if setup_error:
                raise OSError("body spawn failed")

        def poll(self):
            return 0

        def wait(self):
            return 0

    def snapshot(_root, _environment, phase, *_args, **_kwargs):
        if phase == "after":
            raise scope["SnapshotCleanupError"]("after verifier cleanup remains uncertain")
        return {"snapshot": "same", "budget": 20, "slowest": 1}

    scope.update(subprocess=types.SimpleNamespace(Popen=ExitedBody),
                 capture_snapshot=snapshot, clock_now=lambda: 0,
                 wait_for_owned_children=lambda _deadline: True,
                 _remove_gate_scratch=retire_fixture_allocation)
    result = scope["run_supervised"](
        Path.cwd(), ["not-executed"], {"APERTURE_GATE_TIME_LEFT_S": "20"}, 0,
        types.SimpleNamespace(path="private-receipt", token="private-token"), threading.Event()
    )
    require(result == 98 and owner.retirement_complete is False, "uncertain verifier cleanup did not decline retirement")
    require(len(allocations) == 1 and allocations[0].is_dir(), "uncertain verifier cleanup retired its scratch")


def linux_incomplete_marker():
    marker = b"APERTURE-GATE-INDETERMINATE reason="
    tail = b"timeout: child"

    def split_capture():
        scope, owner, accepted, _ = namespace()
        scope["clock_now"] = lambda: 0
        capture = owner.add_capture("stdout", replay=False)
        stderr = owner.add_capture("stderr")
        prefix = b"OUT\n"
        partial_marker = b"APERTURE-GATE-INDETERMINATE reas"
        capture.write(prefix + partial_marker)
        capture.flush()
        cursor = {"offset": 0, "source_line_start": True, "output_line_start": True}
        first = scope["_stream_stdout"](capture.name, cursor, deadline=20)
        require(first == len(prefix) and bytes(accepted[11]) == prefix,
                "split marker prefix changed ordinary output")
        capture.write(b"on=" + tail)
        capture.flush()
        final = scope["_stream_stdout"](capture.name, cursor, final=True, deadline=20)
        return scope, owner, accepted, capture, stderr, cursor, final, prefix + marker + tail

    scope, owner, accepted, capture, stderr, cursor, final, data = split_capture()
    require(final is None and bytes(accepted[11]) == b"OUT\n",
            "unterminated marker was relayed as ordinary stdout")
    owner.request("timeout", "parent timeout", stdout_cursor=cursor, stdout_deadline=20)
    require(scope["_emit_job_stderr"](stderr.name, capture.name, 98, True, cursor, 20),
            "timeout output could not be staged")
    staged = next(Path(output["path"]) for output in owner.outputs if output.get("pending_marker"))
    capture.close()
    Path(capture.name).unlink()
    require(owner.publish(98) == 98, "incomplete marker changed the supervisor result")
    require(bytes(accepted[11]).count(marker) == 1, "supervisor published two terminal records")
    require(cursor["offset"] == len(b"OUT\n"), "incomplete marker changed the accepted offset")
    require(staged.read_bytes() == data[len(b"OUT\n"):] and os.fsencode(staged) in accepted[11],
            "incomplete marker range was not retained and reported")
    require(owner.verdict_range_count == 0, "incomplete marker created an unbounded journal entry")
    owner.close_captures()

    for result in (0, 98):
        scope, owner, accepted, capture, stderr, cursor, final, data = split_capture()
        require(final is None and bytes(accepted[11]) == b"OUT\n",
                "normal output relayed an incomplete marker before its result was known")
        require(scope["_stream_stdout"](capture.name, cursor, deadline=20) is None
                and cursor["offset"] == len(b"OUT\n"), "a later phase advanced the pending marker")
        owner.request(None, None, stdout_cursor=cursor, stdout_deadline=20)
        require(scope["_emit_job_stderr"](stderr.name, capture.name, result, True, cursor, 20),
                "normal output could not be staged")
        capture.close()
        Path(capture.name).unlink()
        require(owner.publish(result) == result and bytes(accepted[11]) == data,
                "normal result did not preserve raw ordinary output")
        require(cursor["offset"] == len(data), "normal relay lost its accepted offset")
        owner.close_captures()

    raw_scope, raw_owner, raw_accepted, _ = namespace()
    raw_scope["clock_now"] = lambda: 0
    raw_data = b"RAW_EXIT_98\n"
    raw_capture = raw_owner.add_capture("stdout", replay=False)
    raw_stderr = raw_owner.add_capture("stderr")
    raw_capture.write(raw_data)
    raw_capture.flush()
    raw_cursor = {"offset": 0, "source_line_start": True, "output_line_start": True}
    raw_final = raw_scope["_stream_stdout"](raw_capture.name, raw_cursor, final=True, deadline=20)
    require(raw_final == len(b"RAW_EXIT_98\n"), "literal raw exit 98 output was withheld")
    require(raw_scope["_emit_job_stderr"](raw_stderr.name, raw_capture.name, 98, True, raw_cursor, 20),
            "literal raw exit 98 output could not be staged")
    require(raw_owner.publish(98) == 98 and bytes(raw_accepted[11]) == b"RAW_EXIT_98\n",
            "literal raw exit 98 was rewritten as a terminal marker")
    raw_owner.close_captures()

    for reason in ("timeout", "cleanup"):
        scoped, selected_owner, selected_accepted, selected_capture, selected_stderr, selected_cursor, selected_final, selected_data = split_capture()
        require(selected_final is None, "incomplete marker was not held for " + reason)
        selected_owner.request(reason, "parent " + reason, stdout_cursor=selected_cursor, stdout_deadline=20)
        require(scoped["_emit_job_stderr"](
            selected_stderr.name, selected_capture.name, 98, True, selected_cursor, 20
        ), "failed output could not be staged for " + reason)
        require(selected_owner.publish(98) == 98, reason + " changed the supervisor result")
        require(bytes(selected_accepted[11]).count(marker) == 1,
                reason + " published an incomplete child marker and a second verdict")
        retained = next(Path(output["path"]) for output in selected_owner.outputs if output.get("pending_marker"))
        require(retained.read_bytes() == selected_data[len(b"OUT\n"):] and os.fsencode(retained) in selected_accepted[11],
                reason + " discarded the incomplete marker evidence")
        selected_owner.close_captures()


def linux_post_exit_cancel():
    if sys.platform != "linux":
        return
    scope, owner, accepted, calls = namespace()
    scope["_remove_gate_scratch"] = retire_fixture_allocation
    phases = []
    interrupted = threading.Event()
    actor = None

    with tempfile.TemporaryDirectory(prefix="terminal-adopted-child-") as actor_root:
        actor_path = Path(actor_root) / "actor-exit"
        ready_path = Path(actor_root) / "actor-ready"

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
                    "ready=pathlib.Path(sys.argv[2])\n"
                    "def stopped(signum, frame):\n"
                    " target.write_text('terminated')\n"
                    " raise SystemExit(0)\n"
                    "signal.signal(signal.SIGTERM, stopped)\n"
                    "ready.write_text('ready')\n"
                    "time.sleep(8)\n"
                    "target.write_text('self-destructed')\n"
                )
                actor = subprocess.Popen(
                    [sys.executable, "-I", "-c", actor_code, str(actor_path), str(ready_path)],
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                ready_deadline = time.monotonic() + 10
                while not ready_path.exists() and time.monotonic() < ready_deadline:
                    time.sleep(0.01)
                require(ready_path.exists(), "adopted child handler did not become ready")

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
        require(owner.record_verdict_range(0, len(marker)), "large verdict range was not journaled")
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

        writer = scope["_source_write_job_output"]
        scope["time"] = types.SimpleNamespace(sleep=lambda _: require(False, "expired writer retried after waiting"))
        for expired in (payload, expected):
            for blocked in (False, True):
                attempts = []

                def write(_, data):
                    attempts.append(bytes(data))
                    if blocked:
                        raise BlockingIOError()
                    return len(data)

                scope["os"] = types.SimpleNamespace(get_blocking=lambda _: True, set_blocking=lambda *_: None, write=write)
                state = {}
                written = writer(11, expired, deadline=0, logical_state=state)
                require(attempts == [expired], "expired writer skipped first attempt")
                require(written == (0 if blocked else len(expired)), "expired writer lost accepted byte count")
                require(writer(11, expired, deadline=0, logical_state=state) == 0 and attempts == [expired],
                        "expired writer retried an attempted range")
    finally:
        source.unlink(missing_ok=True)


def scratch_retirement_deadline():
    for case in ("complete", "failed", "expired", "stalled", "not-reaped"):
        scope, _, _, _ = namespace()
        deadline = 20
        clock = [deadline if case == "expired" else 19.8]
        events = []

        class Remover:
            pid = 10101

            def wait(self, timeout):
                events.append(("wait", timeout))
                if case in ("complete", "failed"):
                    return 0 if case == "complete" else 2
                clock[0] += timeout
                if not any(event[0] == "kill" for event in events) or case == "not-reaped":
                    raise subprocess.TimeoutExpired("scratch remover", timeout)
                return -9

            def kill(self):
                events.append(("kill", self.pid))

        def launch(argv, **kwargs):
            require(events == [("reaping", None)], "remover did not acquire child wait ownership before spawning")
            require(argv[1:5] == ["-I", "-S", "-B", "-c"] and argv[-1] == "/private/allocation",
                    "unverified removal command")
            events.append(("launch", None))
            return Remover()

        scope["clock_now"] = lambda: clock[0]
        scope["establish_reaping_contract"] = lambda: events.append(("reaping", None))
        scope["subprocess"] = types.SimpleNamespace(Popen=launch, TimeoutExpired=subprocess.TimeoutExpired,
                                                    DEVNULL=subprocess.DEVNULL)
        try:
            scope["_remove_gate_scratch"]("/private/allocation", deadline)
        except OSError as error:
            require(case != "complete", "completed retirement was refused")
            if case == "expired":
                require(events == [("reaping", None)] and "no time to start" in str(error),
                        "retirement spawned on an expired deadline")
            elif case == "failed":
                require("status 2" in str(error) and len(events) == 3, "nonzero removal was claimed complete")
            else:
                require([event[0] for event in events] == ["reaping", "launch", "wait", "kill", "wait"],
                        "stalled retirement did not stop and reap its owned helper")
                require(clock[0] <= deadline, "retirement burned time after the deadline")
                require(("cleanup uncertain" in str(error)) == (case == "not-reaped"),
                        "retirement lost uncertain reaping state")
        else:
            require(case == "complete" and [event[0] for event in events] == ["reaping", "launch", "wait"],
                    "unproved retirement returned success")

    scope, _, _, _ = namespace()
    scope["sys"] = sys
    scratch = Path(tempfile.mkdtemp(prefix="bounded-retirement-"))
    (scratch / "owned").write_text("scratch")
    scope["_remove_gate_scratch"](str(scratch), scope["clock_now"]() + 5)
    require(not scratch.exists(), "verified scratch retirement left the allocation on disk")


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
    late_newline = mode == "late-newline"
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
    scope["_remove_gate_scratch"] = lambda path, deadline: scope["shutil"].rmtree(path)
    scope["_service_state"] = lambda *args: {"present": False}

    def bootstrap(*args):
        Path(allocations[-1], "stderr.log").write_bytes(large_stderr if large else b"ERR_ONCE\n")
        ordinary_stdout = b"BOOT_OUT\nAPERTURE-GATE-INDETERMINATE reason=capacity: child"
        if late_newline:
            stdout_payload = ordinary_stdout
        else:
            stdout_payload = b"BOOT_OUT\nAPERTURE-GATE-INDETERMINATE reason=capacity: child\nTAIL\n"
        Path(allocations[-1], "stdout.log").write_bytes(
            large_stdout if large else stdout_payload
        )
        return types.SimpleNamespace(returncode=1 if mode == "bootstrap" else 0, stdout="", stderr="bootstrap refused")

    scope["_launchctl"] = bootstrap

    def phase_failure(*args, **kwargs):
        if late_newline:
            with open(Path(allocations[-1], "stdout.log"), "ab") as handle:
                handle.write(b"\nTAIL\n")
        raise OSError("controlled phase failure")

    scope["_wait_job_phase"] = phase_failure

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
    if late_newline:
        require(bytes(accepted[11]).count(b"TAIL\n") == 1,
                "Darwin late newline duplicated the accepted suffix")


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
        elif scenario == "scratch-retirement-deadline":
            scratch_retirement_deadline()
        elif scenario == "linux-multiple-markers":
            linux_multiple_markers()
        elif scenario == "linux-journal-short-write":
            linux_journal_short_write()
        elif scenario == "linux-adopted-child-drain":
            linux_adopted_child_drain()
        elif scenario == "linux-final-relay-reserve":
            linux_final_relay_reserve()
        elif scenario == "linux-permanent-relay-failure":
            linux_final_relay_reserve(permanent=True)
        elif scenario in ("linux-verifier-cleanup", "linux-setup-verifier-cleanup"):
            linux_verifier_cleanup(setup_error=scenario == "linux-setup-verifier-cleanup")
        elif scenario == "linux-incomplete-marker":
            linux_incomplete_marker()
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
