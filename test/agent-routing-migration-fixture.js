const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SurfaceState, READINESS, MESSAGE_STATES } = require('../src/state');
const { THREAD_STATES } = require('../src/state/thread-enrollment');
const { AGENT_ROUTING_VERSION, resolveAgentReplyRequestMatch } = require('../src/state/agent-routing');
const { legacyParentReconciliationChannel } = require('../src/state/legacy-agent-request-route');
const { runDirectPost } = require('../src/direct-post');
const { main, agentComplete, agentSend } = require('../src/cli');
const { recordNativeAcknowledgment } = require('../src/acknowledgment');
const { codexPrompt, claudeEvent } = require('../src/native');
const { encodeAgentMessage, decodeAgentMessage, issueAgentAddress, KINDS } = require('../src/agent-message');

const source = { guildId: '100', channelId: '101', provider: 'codex', nativeId: '11111111-1111-1111-1111-111111111111', generation: 1 };
const target = { guildId: '100', channelId: '202', provider: 'claude', nativeId: '22222222-2222-2222-2222-222222222222', generation: 1 };
const token = 'agent-routing-fixture';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-routing-migration-'));
  const db = path.join(dir, 'surface.sqlite');
  const state = new SurfaceState(db);
  const secret = path.join(dir, 'secret');
  fs.writeFileSync(secret, `DISCORD_TOKEN=${token}\n`, { mode: 0o600 });
  state.setConfig({ operatorId: '900', guildId: '100', secretFile: secret });
  state.bind({ ...source, workspace: dir, conductorId: 'fixture', repoKey: 'repo:fixture' }, { intakeCutoff: '100' });
  const binding = state.setBindingReadiness('101', READINESS.READY, 'fixture ready', state.getBinding('101'));
  const textFile = path.join(dir, 'task.txt');
  fs.writeFileSync(textFile, 'Preserve the task and its custody.');
  t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, state, binding, textFile };
}

function enroll(f, threadId = '103') {
  f.state.enrollThread({ threadId, parentChannelId: '101', guildId: '100', adoptionCutoff: '100'}, f.binding);
  f.state.markThreadBoundary(threadId, THREAD_STATES.READY, 'fixture ready', null, null, f.binding);
}

function legacyPost(f, outcome = 'not_sent', suppliedPacket = null) {
  const packet = suppliedPacket || { id: 'legacy-post', kind: KINDS.REQUEST, source, target, replyTo: null, text: fs.readFileSync(f.textFile, 'utf8') };
  const meta = { requestId: packet.id, inReplyTo: null, attemptId: 'legacy-attempt', sourcePath: f.textFile,
    textHash: hash(JSON.stringify(packet)), operatorId: '900', partHash: hash(encodeAgentMessage(packet, token)),
    ...source, conductorId: 'fixture', repoKey: 'repo:fixture', partIndex: 0, partCount: 1, nonce: 'legacy-nonce',
    binding: f.binding, deliveryChannelId: target.channelId, agentPacket: packet, presentation: 'legacy' };
  assert.equal(f.state.beginDirectPostPart(meta).claimed, true);
  f.state.recordDirectPostOutcome(packet.id, meta.attemptId, outcome, outcome === 'sent' ? { messageId: 'legacy-sent' } : {});
  return packet;
}

function input(f, extra = {}) {
  return { state: f.state, token, nativeId: source.nativeId, generation: 1, channelId: '101', provider: 'codex',
    textFile: f.textFile, dedupeKey: 'legacy-post', agentThreadId: '103', agentTarget: issueAgentAddress(target, token), ...extra };
}

function legacyPreflight(f, requestId, outcome) {
  const attempt = f.state.directPostRows(requestId).find(row => row.kind === 'direct-post-attempt');
  assert.ok(attempt);
  return f.state.recordDirectPostPreflight(attempt.detail, outcome, { reason: `fixture ${outcome}` });
}

function acceptRequest(f, id, legacy, requestTarget = source, packetId = `request-${id}`) {
  const packet = { id: packetId, kind: KINDS.REQUEST, source: target, target: requestTarget, replyTo: null, text: 'Pending request.' };
  const content = encodeAgentMessage(packet, token);
  if (legacy && requestTarget.channelId === source.channelId) {
    const binding = f.state.getBinding(source.channelId);
    const timestamp = new Date().toISOString();
    f.state.db.prepare(`INSERT INTO messages(discord_id, guild_id, channel_id, delivery_channel_id, author_id, content, attachments, provider, native_id, workspace, endpoint, conductor_id, repo_key, generation, state, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, packet.target.guildId, source.channelId, source.channelId, '901', content, '[]', binding.provider, binding.nativeId,
      binding.workspace, binding.endpoint, binding.conductorId, binding.repoKey, binding.generation, MESSAGE_STATES.ACCEPTED, timestamp, timestamp
    );
    f.state.receipt(id, 'agent-message', { packet, authorId: '901' });
    f.state.receipt(id, 'accepted', { channelId: source.channelId, conductorId: binding.conductorId, generation: binding.generation, readiness: 'ready' });
  } else {
    assert.equal(f.state.acceptDiscordMessage({ id, guildId: '100', channelId: requestTarget.channelId, authorId: '901', isBot: true,
      content }, { agentToken: token }).accepted, true);
  }
  if (!legacy) assert.equal(f.state.getAgentMessage(id).routingVersion, AGENT_ROUTING_VERSION);
  if (legacy) {
    // Model a receipt written by the pre-upgrade intake owner.
    f.state.db.prepare("UPDATE receipts SET detail=json_remove(detail, '$.routingVersion') WHERE discord_id=? AND kind='agent-message'").run(id);
  }
  return packet;
}

function alreadySubmittedLegacyRequest(f, id) {
  f.state.db.prepare('UPDATE messages SET state=? WHERE discord_id=?')
    .run(MESSAGE_STATES.SUBMITTED, id);
}


module.exports = { source, target, token, hash, fixture, enroll, legacyPost, input, legacyPreflight, acceptRequest, alreadySubmittedLegacyRequest };
