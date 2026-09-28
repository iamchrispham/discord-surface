const PREFIX = 'Native proof recovery v1: ';
export const NATIVE_PROOF_PHASES = Object.freeze({ BEFORE_BINDING: 'before-binding', PREFLIGHT: 'preflight' } as const);
type Phase = typeof NATIVE_PROOF_PHASES[keyof typeof NATIVE_PROOF_PHASES];

function parseNativeProofDeadline(detail: string | null | undefined): { phase: Phase } | null {
  if (!detail?.startsWith(PREFIX)) return null;
  try {
    const value = JSON.parse(detail.slice(PREFIX.length));
    return value?.kind === 'deadline' && Object.values(NATIVE_PROOF_PHASES).includes(value.phase) &&
      Number.isFinite(value.deadline) && Number.isFinite(value.observedAt) ? value : null;
  } catch { return null; }
}

export function nativeProofDeadlineDetail(phase: Phase, deadline: number, observedAt = Date.now()): string {
  return PREFIX + JSON.stringify({ kind: 'deadline', phase, deadline, observedAt });
}

export function isNativeProofRetryBoundary(state: string | undefined, detail: string | null | undefined): boolean {
  return ['unavailable', 'pending'].includes(state || '') && parseNativeProofDeadline(detail) !== null;
}

export function isNativeProofBeforeBindingBoundary(state: string | undefined, detail: string | null | undefined): boolean {
  return ['unavailable', 'pending'].includes(state || '') &&
    parseNativeProofDeadline(detail)?.phase === NATIVE_PROOF_PHASES.BEFORE_BINDING;
}
