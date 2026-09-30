const fs = require('node:fs');
const os = require('node:os');
const { PROVIDERS } = require('../state');
const { resolveAgentAddress, resolveDedupeKey, resolveDirectBinding, runDirectPost } = require('../direct-post');
const { issueAgentAddress } = require('../agent-message');
const { readSecret } = require('../discord');
const { resolveInvocationIdentity } = require('../ordinary-codex');

function createDirectPostCommands({ required, openState, print, resolveCurrentClaudeCaller }) {
async function agentSend(args, dependencies = {}) {
  const provider = required(args, 'provider');
  if (!['codex', 'claude'].includes(provider)) throw new Error('invalid agent provider');
  const { state } = openState(args);
  let ordinary;
  try {
    ordinary = state.isOrdinaryBindingRecord(state.getBinding(required(args, 'channel-id')));
  }
  finally { state.close(); }
  const isReply = Object.hasOwn(args, 'agent-reply-to');
  const targetPath = Object.hasOwn(args, 'target-file') ? required(args, 'target-file') : null;
  let agentTarget = null;
  if (targetPath !== null) {
    const stat = fs.statSync(targetPath);
    if (!stat.isFile()) throw new Error('agent target file must be a regular file');
    const fd = fs.openSync(targetPath, 'r');
    const chunks = [];
    let bytesRead = 0;
    try {
      const buffer = Buffer.alloc(1024);
      while (bytesRead <= 2048) {
        const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, 2049 - bytesRead), bytesRead);
        if (length === 0) break;
        chunks.push(Buffer.from(buffer.subarray(0, length)));
        bytesRead += length;
        if (bytesRead > 2048) throw new Error('agent target file is too large');
      }
    } finally { fs.closeSync(fd); }
    agentTarget = JSON.parse(Buffer.concat(chunks, bytesRead).toString('utf8'));
  } else if (!isReply) {
    required(args, 'target-file');
  }
  return directPost(args, provider, ordinary, {
    agentTarget,
    agentMode: true,
    agentThreadId: Object.hasOwn(args, 'agent-thread-id') ? args['agent-thread-id'] : null,
    agentPresentation: args['agent-presentation'],
    fetchImpl: dependencies.fetchImpl,
    print: dependencies.print
  });
}

async function assertOrdinaryPostCaller(state, { provider, nativeId, generation, channelId }, dependencies = {}) {
  const invocation = provider === PROVIDERS.CLAUDE
    ? await (dependencies.resolveClaudeCaller || (() => resolveCurrentClaudeCaller(dependencies)))()
    : (dependencies.resolveInvocationIdentity || resolveInvocationIdentity)(dependencies.environment || process.env);
  if (provider === PROVIDERS.CLAUDE &&
    (!invocation || invocation.harness !== 'claude-code' || typeof invocation.sessionId !== 'string')) {
    throw new Error('ordinary Claude caller identity is unavailable or uses the wrong harness');
  }
  const invocationSessionId = invocation.sessionId;
  const invocationThreadId = provider === PROVIDERS.CLAUDE ? invocationSessionId : invocation.threadId;
  const binding = state.getBinding(channelId);
  if (nativeId !== invocationSessionId || invocationThreadId !== invocationSessionId ||
    !binding?.active || binding.provider !== provider || !state.isOrdinaryBindingRecord(binding) || binding.nativeId !== invocationSessionId ||
    Number(binding.generation) !== Number(generation)) {
    throw new Error(`ordinary post identity does not match the active ${provider === PROVIDERS.CLAUDE ? 'Claude' : 'Codex'} binding`);
  }
}

async function directPost(args, provider = null, ordinary = false, dependencies = {}) {
  const output = dependencies.print || print;
  const { paths, state } = openState(args);
  const controller = new AbortController();
  let receivedSignal = null;
  const handleSignal = signal => {
    if (receivedSignal) return;
    receivedSignal = signal;
    controller.abort();
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  try {
    const config = state.requireConfig();
    const dedupeKey = resolveDedupeKey({ dedupeKey: args['dedupe-key'], requestId: args['request-id'] }, { required: !dependencies.exportAddress });
    const hasAgentReplyTo = Object.hasOwn(args, 'agent-reply-to');
    const resume = args.resume === true || args.resume === 'true';
    if (hasAgentReplyTo && !args['agent-reply-to']) throw new Error('agent reply correlation must not be empty');
    const nativeId = required(args, 'native-id');
    const generation = required(args, 'generation');
    const channelId = ordinary ? required(args, 'channel-id') : (args['channel-id'] || null);
    if (ordinary) await assertOrdinaryPostCaller(state, { provider, nativeId, generation, channelId }, dependencies);
    if (dependencies.exportAddress) {
      const binding = resolveDirectBinding(state, { nativeId, generation: Number(generation), channelId, provider, ordinary });
      const address = resolveAgentAddress(state, binding, dependencies.agentThreadId ?? null);
      const envelope = issueAgentAddress(address, readSecret(config.secretFile));
      output(envelope);
      return envelope;
    }
    const result = await runDirectPost({
      state,
      token: readSecret(config.secretFile),
      nativeId,
      generation,
      channelId,
      provider,
      agentThreadId: dependencies.agentThreadId ?? null,
      textFile: Object.hasOwn(args, 'text-file') ? required(args, 'text-file') : undefined,
      attachmentFile: Object.hasOwn(args, 'attachment-file') ? required(args, 'attachment-file') : undefined,
      resume,
      stateDir: paths.stateDir,
      agentTarget: dependencies.agentTarget ?? null,
      agentMode: dependencies.agentMode === true,
      agentPresentation: dependencies.agentPresentation,
      agentKind: hasAgentReplyTo ? 'result' : 'request',
      agentReplyTo: hasAgentReplyTo ? args['agent-reply-to'] : null,
      dedupeKey,
      inReplyTo: args['in-reply-to'],
      signal: controller.signal,
      fetchImpl: dependencies.fetchImpl,
      ordinary
    });
    output(result);
    if (result.status !== 'sent') process.exitCode = 1;
    if (receivedSignal) process.exitCode = 128 + (os.constants.signals?.[receivedSignal] || 1);
    return result;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    state.close();
  }
}

function directPostFileCleanup(args) {
  const { state } = openState(args);
  try {
    const result = state.releaseDirectPostFilePreparation(required(args, 'preparation-id'));
    print(result);
    return result;
  } finally { state.close(); }
}

  return { agentSend, assertOrdinaryPostCaller, directPost, directPostFileCleanup };
}

module.exports = { createDirectPostCommands };
