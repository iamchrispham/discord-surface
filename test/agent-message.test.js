const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { AGENT_MESSAGE_MAX_ENCODED_LENGTH, PREFIX, issueAgentAddress, encodeAgentMessage, decodeAgentMessage, verifyAgentAddress, verifyLegacyAgentAddress, KINDS } = require('../src/agent-message');
const { source, target, packet, token } = require('./agent-message-fixtures');

test('agent packet retains source, destination and task across authenticated encoding', () => {
  const wire = encodeAgentMessage(packet, token);
  assert.deepEqual(decodeAgentMessage(wire, token, target), packet);
  const result = { ...packet, id: 'result-1', kind: KINDS.RESULT, source: target, target: source, replyTo: packet.id, text: 'Found the cause.' };
  assert.deepEqual(decodeAgentMessage(encodeAgentMessage(result, token), token, source), result);
  assert.equal(decodeAgentMessage('Milestone landed. work-1', token, target), null);
});

test('address exports require the current signed envelope version', () => {
  const current = issueAgentAddress(target, token);
  assert.equal(current.version, 2);
  assert.deepEqual(verifyAgentAddress(current, token), target);
  const signingKey = crypto.createHmac('sha256', token).update('discord-tether/agent-message/v1').digest();
  const legacyProof = crypto.createHmac('sha256', signingKey)
    .update(`address/v1\0${JSON.stringify(target)}`).digest('base64url');
  assert.deepEqual(verifyLegacyAgentAddress({ address: target, proof: legacyProof }, token), target);
  assert.throws(() => verifyAgentAddress({ address: target, proof: legacyProof }, token), /complete binding address/);
  assert.throws(() => verifyAgentAddress({ version: 2, address: target, proof: legacyProof }, token), /invalid agent address signature/);
});

test('forged contents, credentials and stale destination cannot authenticate', () => {
  const wire = encodeAgentMessage(packet, token);
  assert.throws(() => decodeAgentMessage(wire, 'different-credential', target), /signature/);
  const [prefixAndBody, mac] = wire.split('.');
  const bodyStart = prefixAndBody.lastIndexOf(':') + 1;
  const forged = prefixAndBody.slice(0, bodyStart) + Buffer.from(JSON.stringify({ ...packet, text: 'Forged instruction' })).toString('base64url') + '.' + mac;
  assert.throws(() => decodeAgentMessage(forged, token, target), /signature/);
  for (const change of [{ generation: 3 }, { channelId: '103' }, { nativeId: source.nativeId }, { provider: 'codex' }, { guildId: '200' }]) {
    assert.throws(() => decodeAgentMessage(wire, token, { ...target, ...change }), /target/);
  }
});

test('packet grammar prevents self-targeting, uncorrelated results and oversized input', () => {
  for (const change of [{ target: source }, { kind: KINDS.RESULT }, { replyTo: 'unexpected' }, { text: ' ' }, { authority: 'operator' }, { source: { ...source, generation: 0 } }]) {
    assert.throws(() => encodeAgentMessage({ ...packet, ...change }, token), /invalid/);
  }
  assert.throws(() => encodeAgentMessage({ ...packet, text: 'x'.repeat(2000) }, token), /encoded size \d+ characters, maximum 2000 characters/);
  const oversizedWire = PREFIX + 'x'.repeat(AGENT_MESSAGE_MAX_ENCODED_LENGTH - PREFIX.length + 1);
  assert.throws(() => decodeAgentMessage(oversizedWire, token, target), /encoded size 2001 characters, maximum 2000 characters/);
});

test('agent packet reports the measured encoded size and accepts the exact boundary', () => {
  let low = 1;
  let high = AGENT_MESSAGE_MAX_ENCODED_LENGTH;
  let boundary = null;
  while (low <= high) {
    const textLength = Math.floor((low + high) / 2);
    const candidate = { ...packet, text: 'x'.repeat(textLength) };
    try {
      boundary = { packet: candidate, wire: encodeAgentMessage(candidate, token) };
      low = textLength + 1;
    } catch (error) {
      assert.match(error.message, /encoded size \d+ characters, maximum 2000 characters/);
      high = textLength - 1;
    }
  }
  assert.ok(boundary);
  assert.equal(boundary.wire.length, AGENT_MESSAGE_MAX_ENCODED_LENGTH);
  assert.deepEqual(decodeAgentMessage(boundary.wire, token, target), boundary.packet);

  const oversizedPacket = { ...packet, text: `${boundary.packet.text}x` };
  const oversizedBody = Buffer.from(JSON.stringify(oversizedPacket)).toString('base64url');
  const signatureLength = boundary.wire.slice(boundary.wire.lastIndexOf('.') + 1).length;
  const expectedLength = PREFIX.length + oversizedBody.length + 1 + signatureLength;
  assert.ok(expectedLength > AGENT_MESSAGE_MAX_ENCODED_LENGTH);
  assert.throws(() => encodeAgentMessage(oversizedPacket, token), error => {
    assert.equal(error.message,
      `agent message exceeds Discord message limit: encoded size ${expectedLength} characters, maximum ${AGENT_MESSAGE_MAX_ENCODED_LENGTH} characters`);
    return true;
  });
});

test('agent-send help explains encoded size and variable text budget', () => {
  const cli = path.resolve(__dirname, '../src/cli.js');
  const result = require('node:child_process').spawnSync(process.execPath, [cli, 'agent-send', '--help'], {
    encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2000 encoded characters/);
  assert.match(result.stdout, /UTF-8 width/);
  assert.match(result.stdout, /JSON escaping/);
});
