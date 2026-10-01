import * as fs from 'node:fs';
import { COURIER_RECEIPT_KINDS } from './constants';
import { canonicalWorkspace, validatePersistedForwardEligibility, type ForwardState } from './forward';
import { getRoute } from './route';
import type { CourierDependencies, SqlRow } from './types';

export interface CourierInput {
  threadId: string;
  prompt: string;
  hostId?: string;
}

// The CLI supplies process.cwd(), whose OS-resolved real path can differ from
// the registered workspace when a parent directory is a symlink (for example
// macOS /var -> /private/var). Resolve both sides so an aliased but identical
// workspace is still accepted, while a genuinely different directory refuses.
// The public hook keeps its existing literal comparison and is untouched.
function resolvedWorkspace(value: unknown): string | null {
  const canonical = canonicalWorkspace(value);
  if (canonical === null) return null;
  try {
    return canonicalWorkspace(fs.realpathSync(canonical)) || canonical;
  } catch {
    return canonical;
  }
}

// Read-only projection of one admitted courier attempt. The public hook
// (claimCourierForward) is the only writer of forwarding permission; this reader
// exists so a courier host can forward the exact persisted tool input instead of
// a model-transcribed copy. It must never mutate state, and in particular it
// must not call authorizeCourierAttempt, which records rejection receipts.
export function readCourierInput(
  deps: CourierDependencies,
  state: ForwardState,
  routeId: string,
  messageId: string,
  attemptId: string,
  nativeId: string,
  workspace: string
): CourierInput {
  deps.assertText(routeId, 'routeId', 128);
  deps.assertText(messageId, 'messageId', 128);
  deps.assertText(attemptId, 'attemptId', 128);
  deps.assertText(nativeId, 'nativeId', 128);
  const callerWorkspace = resolvedWorkspace(workspace);
  if (callerWorkspace === null) throw new deps.BindingError('courier persisted input workspace is invalid');
  const route = getRoute(deps, state, routeId);
  const persistedWorkspace = route ? resolvedWorkspace(route.courier.workspace) : null;
  if (route === null || persistedWorkspace === null || callerWorkspace !== persistedWorkspace) {
    throw new deps.BindingError('courier persisted input route or workspace is not current');
  }

  // Exactly one ATTEMPT receipt must carry the full identity the caller named.
  const rows = state.db.prepare(`SELECT id, discord_id, detail FROM receipts WHERE kind=?
    AND discord_id=?
    AND json_extract(detail, '$.route.routeId')=?
    AND json_extract(detail, '$.attemptId')=?
    AND json_extract(detail, '$.courier.nativeId')=? LIMIT 2`)
    .all(COURIER_RECEIPT_KINDS.ATTEMPT, messageId, routeId, attemptId, nativeId);
  if (rows.length !== 1) throw new deps.BindingError('courier persisted input requires one exact attempt');
  const saved = deps.parseJson((rows[0] as SqlRow).detail, null);
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved) ||
      typeof saved.prompt !== 'string' || typeof saved.attemptId !== 'string' ||
      saved.attemptId !== attemptId || saved.route?.routeId !== routeId ||
      saved.courier?.nativeId !== nativeId || !saved.envelope || typeof saved.envelope !== 'object') {
    throw new deps.BindingError('courier persisted attempt receipt is malformed');
  }

  const current = state.getCourierAttempt(messageId, attemptId);
  const message = state.getMessage(messageId);
  if (!current || !message) throw new deps.BindingError('courier attempt is unavailable');
  // The symlink-aware equality above is this reader's workspace gate. Hand the
  // validator the registered workspace so the shared literal comparison stays
  // exactly the hook's, and every other eligibility rule is shared.
  const { envelope } = validatePersistedForwardEligibility(deps, state, {
    routeId,
    workspace: route.courier.workspace,
    messageId,
    attemptId,
    attemptReceiptId: Number((rows[0] as SqlRow).id),
    prompt: saved.prompt,
    message,
    current,
    routeError: 'courier persisted input route or workspace is not current'
  });

  const hostId = envelope.recipient.hostId;
  return typeof hostId === 'string' && hostId.length > 0
    ? { threadId: envelope.recipient.threadId, prompt: envelope.prompt, hostId }
    : { threadId: envelope.recipient.threadId, prompt: envelope.prompt };
}
