import {
  isNativeProofRetryBoundary,
  NATIVE_PROOF_PHASES,
  nativeProofDeadlineDetail
} from '../../src/discord/native-proof-recovery';

type NativeProofPhase = typeof NATIVE_PROOF_PHASES[keyof typeof NATIVE_PROOF_PHASES];

const renderDeadline: (phase: NativeProofPhase, deadline: number, observedAt?: number) => string =
  nativeProofDeadlineDetail;
const detectRetryBoundary: (state: string | undefined, detail: string | null | undefined) => boolean =
  isNativeProofRetryBoundary;

const phase: NativeProofPhase = NATIVE_PROOF_PHASES.PREFLIGHT;
const detail: string = renderDeadline(phase, 100, 200);
const retryable: boolean = detectRetryBoundary('unavailable', detail);

void renderDeadline;
void detectRetryBoundary;
void retryable;

// @ts-expect-error consumers cannot invent a recovery phase
renderDeadline('retry', 300);

// @ts-expect-error consumers must provide a numeric deadline
renderDeadline(NATIVE_PROOF_PHASES.PREFLIGHT, 'soon');
