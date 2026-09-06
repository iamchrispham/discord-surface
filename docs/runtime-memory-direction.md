# Runtime memory baseline and language direction

The operator identified memory and CPU pressure from concurrent conductors as a design constraint. Do not perform a TypeScript migration as a memory optimization. Type annotations do not remove the JavaScript runtime.

## Observed baseline

At source head 255abf1672cf078fc6282b273c5b2c19441acb15, the owning command `node --test test/surface.test.js` passed all 123 tests in one instrumented run. Sampling the runner and descendants observed 352.0 MiB aggregate RSS over 109 samples. Five Node processes were present at the maximum observed sample. Shared pages can be counted repeatedly, and sampling can miss short peaks. This is not a hard maximum or an attribution of all memory to V8. The run completed in 13.36 seconds with sampling overhead. CPU consumption was not measured.

The existing production Gateway PID 22086 reported a macOS physical footprint of 146.4M and a lifetime peak of 1.1G. Claude Monitor PID 36742 reported 16.4M and a peak of 18.0M. These are vmmap footprint metrics, not the sampled RSS metric above. The peak's cause and timing have not been established. The production processes were not restarted or modified.

`src/native.js` reads the entire native session file in `findCodexSessionFile` to inspect its first line and in `observeCodexReply` on each observation before selecting bytes after the saved offset. This is a concrete source of file-size-dependent allocation. It is a candidate explanation for memory pressure, not proof of the measured peak's cause.

## Recommended direction, not an implemented migration

Prefer Rust for the long-running adapter when minimizing runtime footprint is the primary criterion. It has no mandatory tracing garbage collector. Go remains a simpler implementation alternative but retains a GC runtime and its memory limit is soft. There is no representative Rust or Go implementation measured yet, so no savings or CPU improvement is claimed.

Before replacing the live service, measure bounded transcript reads, port one end-to-end custody path with the same SQLite and native-session contracts, and compare equivalent workloads including child processes. Preserve generation checks, duplicate handling, cancellation, restart custody and existing session identities. Use the current test behavior as the acceptance reference. Do not run a replacement live Gateway alongside the existing consumer. A language change cannot substitute for bounded reads and resource cleanup.

## Sources

- [TypeScript type erasure](https://www.typescriptlang.org/docs/handbook/2/classes)
- [Go garbage collector and soft memory limit](https://go.dev/doc/gc-guide)
- [Rust language properties](https://rust-lang.org/)
- [Node process memory metrics](https://nodejs.org/api/process.html)
