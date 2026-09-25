import {
  isNativeProofRetryBoundary,
  NATIVE_PROOF_PHASES,
  nativeProofDeadlineDetail
} from '../../src/discord/native-proof-recovery';

type NativeProofPhase = Parameters<typeof nativeProofDeadlineDetail>[0];

const phases: readonly NativeProofPhase[] = Object.values(NATIVE_PROOF_PHASES);
const preflight = nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, 100);
const beforeBinding = nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.BEFORE_BINDING, 200);
const retryable: boolean = isNativeProofRetryBoundary('unavailable', preflight);
const notRetryable: boolean = isNativeProofRetryBoundary('ready', beforeBinding);

void phases;
void retryable;
void notRetryable;

// @ts-expect-error consumers cannot invent a recovery phase
nativeProofDeadlineDetail('retry', 300);

// @ts-expect-error consumers must provide a numeric deadline
nativeProofDeadlineDetail(NATIVE_PROOF_PHASES.PREFLIGHT, 'soon');
