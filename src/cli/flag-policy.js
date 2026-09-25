// Issue #110: every selected CLI command must reject flags it does not consume
// before opening state, claiming custody, or writing to Discord. This module owns
// the per-command allowed-flag vocabulary, the unknown-flag error text, and the
// nearest-option suggestion. It is intentionally free of I/O so src/cli.js can run
// it at parse time, ahead of the courier-guard startup path and main dispatch.

const COMMON_FLAGS = Object.freeze(['state-dir', 'db', 'help']);
const DIRECT_HANDOFF_FLAGS = Object.freeze(['provider', 'conductor-id', 'repo-key', 'from-native-id', 'native-id',
  'from-generation', 'endpoint', 'workspace', 'channel-id', 'handoff-id', 'category-id']);
const ORDINARY_HANDOFF_FLAGS = Object.freeze(['ordinary', 'provider', 'from-native-id', 'native-id',
  'from-generation', 'workspace', 'channel-id', 'handoff-id', 'session-root']);
const LOCK_HANDOFF_FLAGS = Object.freeze(['from-lock', 'repo', 'provider', 'conductor-id', 'repo-key',
  'native-id', 'endpoint', 'workspace', 'session-file', 'worker-file', 'category-id']);
const LOCAL_HANDOFF_FLAGS = Object.freeze(['provider', 'conductor-id', 'repo-key', 'from-native-id', 'native-id',
  'from-generation', 'endpoint', 'workspace', 'channel-id', 'handoff-id', 'enrollment-proof', 'intake-cutoff', 'reuse']);
const RECOVER_FLAGS = Object.freeze({
  board: ['board-attempt-id', 'board-channel-id', 'board-evidence-scope', 'board-guild-id', 'board-message-id',
    'board-no-hidden-retry', 'board-readback', 'board-readback-at', 'board-resolution', 'board-single-attempt', 'board-sole-writer'],
  topic: ['topic-channel-id', 'topic-request-id', 'resolution', 'evidence-scope', 'topic-readback', 'topic-readback-at'],
  intake: ['intake-channel-id'],
  reply: ['message-id', 'resolution', 'part-index', 'reply-message-id'],
  directPost: ['direct-post-request-id', 'direct-post-attempt-id', 'direct-post-message-id', 'direct-post-nonce',
    'resolution', 'evidence-scope'],
  message: ['message-id', 'resolution'],
  restart: []
});

function recoverMode(args = {}) {
  if (Object.keys(args).some(key => key.startsWith('board-') && args[key] !== undefined)) return 'board';
  if (args['topic-channel-id']) return 'topic';
  if (args['intake-channel-id']) return 'intake';
  if (args['message-id'] && ['reply_sent', 'reply_not_sent'].includes(args.resolution)) return 'reply';
  if (args['direct-post-request-id']) return 'directPost';
  if (args['message-id'] && args.resolution) return 'message';
  return 'restart';
}

// FIXED inventory from the issue-110 build brief. Group identical families; the
// policy is per selected command, never one global set. A missing entry fails
// closed in validateFlags so a future dispatch case cannot silently pass.
const COMMAND_FLAGS = Object.freeze({
  configure: ['operator-id', 'guild-id', 'secret-file', 'codex-category-id', 'claude-category-id'],
  bind: ['channel-id', 'guild-id', 'provider', 'native-id', 'workspace', 'endpoint', 'category-id', 'conductor-id', 'repo-key'],
  rebind: ['channel-id', 'guild-id', 'provider', 'native-id', 'workspace', 'endpoint', 'category-id', 'conductor-id', 'repo-key'],
  'ordinary-bind': ['channel', 'channel-id', 'workspace', 'session-root', 'native-id'],
  'ordinary-bind-run': ['channel', 'channel-id', 'workspace', 'session-root', 'native-id'],
  'ordinary-claude-bind': ['channel', 'channel-id', 'endpoint', 'socket', 'transcript', 'workspace', 'native-id'],
  'ordinary-claude-bind-run': ['channel', 'channel-id', 'endpoint', 'socket', 'transcript', 'workspace', 'native-id'],
  unbind: ['channel-id'],
  status: [],
  recover: RECOVER_FLAGS.restart,
  'board-refresh': ['channel-id', 'dedupe-key', 'generation', 'message-id', 'native-id', 'request-id', 'text-file'],
  provision: ['provider', 'native-id', 'conductor-id', 'repo-key', 'channel-id', 'task-name', 'workspace', 'endpoint', 'category-id', 'migrate-legacy-topic'],
  'provision-run': ['provider', 'native-id', 'conductor-id', 'repo-key', 'channel-id', 'task-name', 'workspace', 'endpoint', 'category-id', 'migrate-legacy-topic'],
  handoff: DIRECT_HANDOFF_FLAGS,
  'handoff-run': DIRECT_HANDOFF_FLAGS,
  'handoff-local': LOCAL_HANDOFF_FLAGS,
  start: ['courier-route-id'],
  run: ['courier-route-id', 'reply-timeout-ms'],
  stop: [],
  'claude-channel': ['native-id', 'socket'],
  'claude-monitor': ['native-id', 'socket'],
  'native-ack': ['provider', 'message-id', 'native-id', 'generation'],
  'native-reply': ['provider', 'generation', 'message-id', 'native-id', 'text-file', 'attachment-file'],
  'claude-reply': ['generation', 'message-id', 'native-id', 'text-file', 'attachment-file'],
  'agent-address': ['provider', 'channel-id', 'agent-thread-id', 'native-id', 'generation'],
  'agent-send': ['provider', 'channel-id', 'agent-thread-id', 'native-id', 'generation', 'target-file', 'text-file', 'attachment-file',
    'dedupe-key', 'request-id', 'agent-presentation', 'agent-reply-to', 'resume', 'in-reply-to'],
  'agent-complete': ['provider', 'message-id', 'native-id', 'generation', 'channel-id'],
  'agent-withdraw': ['provider', 'message-id', 'packet-id', 'native-id', 'generation'],
  'watcher-arm': ['arm-key', 'provider', 'channel-id', 'agent-thread-id', 'native-id', 'generation'],
  'watcher-send': ['arm-key', 'trigger-key', 'text-file'],
  'watcher-consume': ['provider', 'message-id', 'native-id', 'generation', 'channel-id'],
  'decision-present': ['request-file', 'canonical-cli', 'canonical-state-root'],
  'thread-enroll': ['channel-id', 'thread-id'],
  post: ['native-id', 'generation', 'channel-id', 'text-file', 'attachment-file', 'dedupe-key', 'request-id', 'resume', 'in-reply-to'],
  'ordinary-post': ['native-id', 'generation', 'channel-id', 'text-file', 'attachment-file', 'dedupe-key', 'request-id', 'resume', 'in-reply-to'],
  'ordinary-claude-post': ['native-id', 'generation', 'channel-id', 'text-file', 'attachment-file', 'dedupe-key', 'request-id', 'resume', 'in-reply-to'],
  'claude-post': ['native-id', 'generation', 'channel-id', 'text-file', 'attachment-file', 'dedupe-key', 'request-id', 'resume', 'in-reply-to'],
  'post-file-cleanup': ['preparation-id'],
  'native-reply-file-cleanup': ['message-id', 'preparation-id', 'part-index'],
  liaison: ['receipt-id'],
  'courier-guard': ['courier-route-id']
});

// Subcommand-scoped policies. A subcommand that is not listed falls back to the
// command entry, so an added subcommand must opt in with its own vocabulary.
const SUBCOMMAND_FLAGS = Object.freeze({
  'liaison draft': ['receipt-id']
});

function allowedFlags(command, subcommand, args) {
  if (command === 'liaison' && subcommand === 'draft') return SUBCOMMAND_FLAGS['liaison draft'];
  if (command === 'recover') return RECOVER_FLAGS[recoverMode(args)];
  if (command === 'handoff' || command === 'handoff-run') {
    if (args?.ordinary === true || args?.ordinary === 'true') return ORDINARY_HANDOFF_FLAGS;
    if (args?.['from-lock'] === true || args?.['from-lock'] === 'true') return LOCK_HANDOFF_FLAGS;
  }
  const entry = Object.hasOwn(COMMAND_FLAGS, command) ? COMMAND_FLAGS[command] : null;
  if (entry === null) return null;
  return entry;
}

function levenshtein(a, b) {
  const previous = new Array(b.length + 1);
  const current = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}

// A candidate qualifies when the unknown name is a hyphen-prefix of it (such as
// --attachment for --attachment-file) or when the edit distance is at most two.
// Ties resolve lexically so the message is deterministic.
function suggestionFor(unknown, allowed) {
  let winner = null;
  let winnerDistance = Infinity;
  for (const candidate of allowed) {
    const prefixed = candidate.startsWith(`${unknown}-`);
    const distance = levenshtein(unknown, candidate);
    if (!prefixed && distance > 2) continue;
    if (distance < winnerDistance || (distance === winnerDistance && (winner === null || candidate < winner))) {
      winner = candidate;
      winnerDistance = distance;
    }
  }
  return winner;
}

// Validates the parsed args for one selected command. `help` and `--help` are
// read-only and bypass unknown-flag validation; callers run that check after the
// duplicate-flag check. Throws an Error with .command set so the courier-guard
// startup path can keep its existing deny JSON and exit code 2.
function validateFlags({ command, subcommand, args } = {}) {
  if (command === 'help' || args?.help === true) return;
  const allowed = allowedFlags(command, subcommand, args);
  const unknown = Object.keys(args || {}).find(key => {
    if (allowed === null) return true;
    return !COMMON_FLAGS.includes(key) && !allowed.includes(key);
  });
  if (unknown === undefined) {
    if (Object.hasOwn(args || {}, 'help') && args.help !== true) {
      throw Object.assign(new Error('--help takes no value'), { command });
    }
    return;
  }
  // Common flags are options for this command too, so they are candidate suggestions.
  const candidates = allowed === null ? null : [...allowed, ...COMMON_FLAGS];
  const suggestion = candidates === null ? null : suggestionFor(unknown, candidates);
  const base = `unknown --${unknown} for ${command}`;
  const message = suggestion === null ? base : `${base}; did you mean --${suggestion}?`;
  throw Object.assign(new Error(message), { command });
}

module.exports = { allowedFlags, COMMAND_FLAGS, COMMON_FLAGS, levenshtein, recoverMode, suggestionFor, validateFlags };
