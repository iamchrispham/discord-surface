import {
  isNativeProofRetryBoundary,
  NATIVE_PROOF_PHASES,
  nativeProofDeadlineDetail
} from '../../src/discord/native-proof-recovery';

type NativeProofPhase = typeof NATIVE_PROOF_PHASES[keyof typeof NATIVE_PROOF_PHASES];

function renderDeadline(phase: NativeProofPhase, deadline: number): string {
  return nativeProofDeadlineDetail(phase, deadline);
}

const phases: readonly NativeProofPhase[] = Object.values(NATIVE_PROOF_PHASES);
const preflight = renderDeadline(NATIVE_PROOF_PHASES.PREFLIGHT, 100);
const beforeBinding = renderDeadline(NATIVE_PROOF_PHASES.BEFORE_BINDING, 200);
const retryable: boolean = isNativeProofRetryBoundary('unavailable', preflight);
const notRetryable: boolean = isNativeProofRetryBoundary('ready', beforeBinding);

void phases;
void retryable;
void notRetryable;

// @ts-expect-error consumers cannot invent a recovery phase
renderDeadline('retry', 300);

// @ts-expect-error consumers must provide a numeric deadline
renderDeadline(NATIVE_PROOF_PHASES.PREFLIGHT, 'soon');
