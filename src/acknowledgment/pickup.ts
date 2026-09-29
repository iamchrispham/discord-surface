// Shared owner for the mandated Claude pickup acknowledgment instruction branch.
//
// All Claude instruction emission sites (Channel MCP initialization and the
// Monitor watcher / agent-completion / human payload instructions) must emit
// this exact sentence sequence once, immediately after the first-step
// acknowledgment command, and before any per-kind work/reply/completion
// instructions. Keep this text verbatim: it is a native instruction contract,
// not user-facing product copy.
export const CLAUDE_PICKUP_ACKNOWLEDGMENT: string =
  'If acknowledgment returns recorded=true, handle this notification normally. ' +
  'If duplicate=true, do not repeat work: only an agent request may follow its duplicate-recovery instruction; all other notifications stop without posting or completing again. ' +
  'If acknowledgment fails or its result is missing or ambiguous, stop and report the error without executing the request. ' +
  'Acknowledgment records receipt, not completed work. It never authorizes retrying interrupted work.';
