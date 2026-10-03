/**
 * Process-owner evidence classification.
 *
 * A recorded producer (PID plus optional start-time/command identity) is either
 * proved absent, proved matching-live, or indeterminate. Indeterminate evidence
 * must never authorize staged-file deletion or settlement of the producer's
 * attempt. Legacy boolean results are normalized at this boundary: `false` is
 * indeterminate, never absence.
 */

export const OWNER_EVIDENCE = Object.freeze({
  MATCHING_LIVE: 'matching-live',
  ABSENT: 'absent',
  INDETERMINATE: 'indeterminate'
} as const);

export const OWNER_EVIDENCE_REASON = Object.freeze({
  INVALID_PID: 'invalid-pid',
  PROBE_ABSENT: 'probe-absent',
  PROBE_DENIED: 'probe-denied',
  PROBE_ERROR: 'probe-error',
  MISSING_IDENTITY: 'missing-identity',
  UNREADABLE_IDENTITY: 'unreadable-identity',
  INCOMPLETE_IDENTITY: 'incomplete-identity',
  IDENTITY_MISMATCH: 'identity-mismatch',
  IDENTITY_MATCH: 'identity-match',
  LEGACY_MATCH: 'legacy-match',
  LEGACY_UNKNOWN: 'legacy-unknown',
  INVALID_EVIDENCE: 'invalid-evidence'
} as const);

export type OwnerEvidenceStatus = (typeof OWNER_EVIDENCE)[keyof typeof OWNER_EVIDENCE];
export type OwnerEvidenceReason = (typeof OWNER_EVIDENCE_REASON)[keyof typeof OWNER_EVIDENCE_REASON];

export interface ProcessOwnerEvidence {
  readonly status: OwnerEvidenceStatus;
  readonly reason: OwnerEvidenceReason;
}

export interface ProcessOwnerProbe {
  probePid(pid: number): unknown;
  captureIdentity(pid: number): unknown;
}

const STATUS_VALUES: readonly OwnerEvidenceStatus[] = Object.values(OWNER_EVIDENCE);
const REASON_VALUES: ReadonlySet<string> = new Set(Object.values(OWNER_EVIDENCE_REASON));

const ALLOWED_REASONS: Readonly<Record<OwnerEvidenceStatus, readonly OwnerEvidenceReason[]>> = Object.freeze({
  [OWNER_EVIDENCE.MATCHING_LIVE]: Object.freeze([OWNER_EVIDENCE_REASON.IDENTITY_MATCH, OWNER_EVIDENCE_REASON.LEGACY_MATCH]),
  [OWNER_EVIDENCE.ABSENT]: Object.freeze([OWNER_EVIDENCE_REASON.PROBE_ABSENT, OWNER_EVIDENCE_REASON.IDENTITY_MISMATCH]),
  [OWNER_EVIDENCE.INDETERMINATE]: Object.freeze([
    OWNER_EVIDENCE_REASON.INVALID_PID,
    OWNER_EVIDENCE_REASON.PROBE_DENIED,
    OWNER_EVIDENCE_REASON.PROBE_ERROR,
    OWNER_EVIDENCE_REASON.MISSING_IDENTITY,
    OWNER_EVIDENCE_REASON.UNREADABLE_IDENTITY,
    OWNER_EVIDENCE_REASON.INCOMPLETE_IDENTITY,
    OWNER_EVIDENCE_REASON.LEGACY_UNKNOWN,
    OWNER_EVIDENCE_REASON.INVALID_EVIDENCE
  ])
});

function evidence(status: OwnerEvidenceStatus, reason: OwnerEvidenceReason): ProcessOwnerEvidence {
  return Object.freeze({ status, reason });
}

function isOwnerEvidenceStatus(value: unknown): value is OwnerEvidenceStatus {
  return typeof value === 'string' && (STATUS_VALUES as readonly string[]).includes(value);
}

function coherentPair(status: unknown, reason: unknown): ProcessOwnerEvidence | null {
  if (!isOwnerEvidenceStatus(status)) return null;
  if (typeof reason !== 'string' || !REASON_VALUES.has(reason)) return null;
  if (!(ALLOWED_REASONS[status] as readonly string[]).includes(reason)) return null;
  return evidence(status, reason as OwnerEvidenceReason);
}

interface RecordedIdentity {
  readonly start: string | null;
  readonly command: string | null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read the recorded identity fields without letting an accessor throw escape.
 * A throwing or unreadable recorded identity is not evidence of absence, so the
 * caller maps `null` to indeterminate/missing-identity.
 */
function readRecordedIdentity(value: unknown): RecordedIdentity | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  let start: unknown;
  let command: unknown;
  try {
    const record = value as Record<string, unknown>;
    start = record.ownerStartTime;
    command = record.ownerCommand;
  } catch {
    return null;
  }
  const recorded = { start: nonemptyString(start), command: nonemptyString(command) };
  return recorded.start === null && recorded.command === null ? null : recorded;
}

interface ActualIdentity {
  readonly start: unknown;
  readonly command: unknown;
}

function readActualIdentity(value: object): ActualIdentity | null {
  try {
    const record = value as Record<string, unknown>;
    return { start: record.ownerStartTime, command: record.ownerCommand };
  } catch {
    return null;
  }
}

function probeFailure(error: unknown): ProcessOwnerEvidence {
  const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === 'ESRCH') return evidence(OWNER_EVIDENCE.ABSENT, OWNER_EVIDENCE_REASON.PROBE_ABSENT);
  if (code === 'EPERM') return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.PROBE_DENIED);
  return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.PROBE_ERROR);
}

/**
 * Classify a recorded producer. The exact order is fixed: validate the PID,
 * prove absence/denial with the PID probe before requiring comparison identity,
 * then require readable and complete recorded/actual identity, then compare.
 */
export function classifyProcessOwner(pid: unknown, expectedIdentity: unknown, deps: ProcessOwnerProbe): ProcessOwnerEvidence {
  let normalizedPid: number;
  try {
    normalizedPid = Number(pid);
  } catch {
    return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.INVALID_PID);
  }
  if (!Number.isInteger(normalizedPid) || normalizedPid < 1) {
    return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.INVALID_PID);
  }
  try {
    deps.probePid(normalizedPid);
  } catch (error) {
    return probeFailure(error);
  }
  const recorded = readRecordedIdentity(expectedIdentity);
  if (recorded === null) {
    return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.MISSING_IDENTITY);
  }
  let actualValue: unknown;
  try {
    actualValue = deps.captureIdentity(normalizedPid);
  } catch {
    return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.UNREADABLE_IDENTITY);
  }
  if (actualValue === null || actualValue === undefined || typeof actualValue !== 'object') {
    return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.UNREADABLE_IDENTITY);
  }
  const actual = readActualIdentity(actualValue);
  if (actual === null) {
    return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.UNREADABLE_IDENTITY);
  }
  const actualStart = nonemptyString(actual.start);
  const actualCommand = nonemptyString(actual.command);
  if ((recorded.start !== null && actualStart === null) || (recorded.command !== null && actualCommand === null)) {
    return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.INCOMPLETE_IDENTITY);
  }
  if ((recorded.start !== null && actualStart !== recorded.start) || (recorded.command !== null && actualCommand !== recorded.command)) {
    return evidence(OWNER_EVIDENCE.ABSENT, OWNER_EVIDENCE_REASON.IDENTITY_MISMATCH);
  }
  return evidence(OWNER_EVIDENCE.MATCHING_LIVE, OWNER_EVIDENCE_REASON.IDENTITY_MATCH);
}

/**
 * Normalize any callback result into typed evidence. Legacy `true` is
 * matching-live, legacy `false` is indeterminate, and every malformed or
 * incoherent value is indeterminate/invalid-evidence. `false` can never
 * normalize to absent or matching-live.
 */
export function normalizeOwnerEvidence(value: unknown): ProcessOwnerEvidence {
  if (value === true) return evidence(OWNER_EVIDENCE.MATCHING_LIVE, OWNER_EVIDENCE_REASON.LEGACY_MATCH);
  if (value === false) return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.LEGACY_UNKNOWN);
  if (value !== null && typeof value === 'object') {
    let status: unknown;
    let reason: unknown;
    try {
      const record = value as Record<string, unknown>;
      status = record.status;
      reason = record.reason;
    } catch {
      return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.INVALID_EVIDENCE);
    }
    const pair = coherentPair(status, reason);
    if (pair !== null) return pair;
  }
  return evidence(OWNER_EVIDENCE.INDETERMINATE, OWNER_EVIDENCE_REASON.INVALID_EVIDENCE);
}
