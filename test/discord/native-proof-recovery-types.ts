import {
  isNativeProofRetryBoundary,
  NATIVE_PROOF_PHASES,
  nativeProofDeadlineDetail
} from '../../src/discord/native-proof-recovery';

const phaseMap: typeof NATIVE_PROOF_PHASES = NATIVE_PROOF_PHASES;
const preflightDetail: string = nativeProofDeadlineDetail(phaseMap.PREFLIGHT, 100, 200);
const beforeBindingDetail: string = nativeProofDeadlineDetail(phaseMap.BEFORE_BINDING, 300);
const retryable: boolean = isNativeProofRetryBoundary('unavailable', preflightDetail);
const notRetryable: boolean = isNativeProofRetryBoundary('ready', beforeBindingDetail);

void retryable;
void notRetryable;

// @ts-expect-error recovery phases are a closed vocabulary
nativeProofDeadlineDetail('retry', 100);
// @ts-expect-error deadlines are numeric timestamps
nativeProofDeadlineDetail(phaseMap.PREFLIGHT, 'soon');
