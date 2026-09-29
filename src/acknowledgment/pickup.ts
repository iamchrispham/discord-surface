// Shared owner for the mandated Claude pickup acknowledgment instruction branch.
//
// All Claude instruction emission sites (Channel MCP initialization and the
// Monitor watcher / agent-completion / human payload instructions) must emit
// this exact sentence sequence once, immediately after the first-step
// acknowledgment command, and before any per-kind work/reply/completion
// instructions. Keep this text verbatim: it is a native instruction contract,
// not user-facing product copy.
export const CLAUDE_PICKUP_ACKNOWLEDGMENT: string =
  'Proceed with this notification only if acknowledgment returns recorded=true. ' +
  'If duplicate=true, stop handling this notification without executing its request or posting or completing it again. ' +
  'If acknowledgment fails or its result is missing or ambiguous, stop and report the error without executing the request. ' +
  'Acknowledgment records receipt, not completed work. It never authorizes retrying interrupted work.';
