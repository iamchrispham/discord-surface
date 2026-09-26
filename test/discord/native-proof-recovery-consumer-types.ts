import {
  isNativeProofRetryBoundary,
  NATIVE_PROOF_PHASES,
  nativeProofDeadlineDetail
} from '../../src/discord/native-proof-recovery';

type NativeProofPhase = Parameters<typeof nativeProofDeadlineDetail>[0];
type NativeProofDeadlineDetail = (phase: NativeProofPhase, deadline: number, observedAt?: number) => string;
type NativeProofRetryBoundary = (state: string | undefined, detail: string | null | undefined) => boolean;

const renderDeadline: NativeProofDeadlineDetail = nativeProofDeadlineDetail;
const detectRetryBoundary: NativeProofRetryBoundary = isNativeProofRetryBoundary;

const phases: readonly NativeProofPhase[] = Object.values(NATIVE_PROOF_PHASES);
const preflight = renderDeadline(NATIVE_PROOF_PHASES.PREFLIGHT, 100);
const beforeBinding = renderDeadline(NATIVE_PROOF_PHASES.BEFORE_BINDING, 200);
const retryable: boolean = detectRetryBoundary('unavailable', preflight);
const notRetryable: boolean = detectRetryBoundary('ready', beforeBinding);

void phases;
void renderDeadline;
void detectRetryBoundary;
void retryable;
void notRetryable;

// @ts-expect-error consumers cannot invent a recovery phase
renderDeadline('retry', 300);

// @ts-expect-error consumers must provide a numeric deadline
renderDeadline(NATIVE_PROOF_PHASES.PREFLIGHT, 'soon');
