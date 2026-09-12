const crypto = require('node:crypto');

const PREFIX = 'discord-tether:agent:v1:';
const DOMAIN = 'discord-tether/agent-message/v1';
const KINDS = Object.freeze({ REQUEST: 'request', RESULT: 'result' });
const LIMIT = 2000;

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validAddress(value) {
  return exactKeys(value, ['guildId', 'channelId', 'provider', 'nativeId', 'generation']) &&
    /^\d{1,20}$/.test(value.guildId) && typeof value.guildId === 'string' &&
    /^\d{1,20}$/.test(value.channelId) && typeof value.channelId === 'string' &&
    ['codex', 'claude'].includes(value.provider) &&
    typeof value.nativeId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.nativeId) &&
    Number.isSafeInteger(value.generation) && value.generation > 0;
}

function sameAddress(left, right) {
  return validAddress(left) && validAddress(right) &&
    Object.keys(left).every(key => left[key] === right[key]);
}

function validate(packet) {
  if (!exactKeys(packet, ['id', 'kind', 'source', 'target', 'replyTo', 'text']) ||
      typeof packet.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(packet.id) ||
      !Object.values(KINDS).includes(packet.kind) || !validAddress(packet.source) || !validAddress(packet.target) ||
      packet.source.guildId !== packet.target.guildId ||
      (packet.source.provider === packet.target.provider && packet.source.nativeId === packet.target.nativeId) ||
      typeof packet.text !== 'string' || !packet.text.trim() ||
      (packet.kind === KINDS.REQUEST ? packet.replyTo !== null :
        typeof packet.replyTo !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(packet.replyTo))) {
    throw new Error('invalid agent message');
  }
}

function signingKey(token) {
  if (typeof token !== 'string' || !token.length) throw new Error('agent message credential unavailable');
  return crypto.createHmac('sha256', token).update(DOMAIN).digest();
}

function signature(body, token) {
  return crypto.createHmac('sha256', signingKey(token)).update(body).digest();
}

function encodeAgentMessage(packet, token) {
  validate(packet);
  const body = Buffer.from(JSON.stringify(packet)).toString('base64url');
  const wire = `${PREFIX}${body}.${signature(body, token).toString('base64url')}`;
  if (wire.length > LIMIT) throw new Error('agent message exceeds Discord message limit');
  return wire;
}

function decodeAgentMessage(wire, token, target) {
  if (typeof wire !== 'string' || !wire.startsWith(PREFIX)) return null;
  if (wire.length > LIMIT) throw new Error('agent message exceeds Discord message limit');
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(wire.slice(PREFIX.length));
  if (!match) throw new Error('invalid agent message encoding');
  const [, body, mac] = match;
  const supplied = Buffer.from(mac, 'base64url');
  if (supplied.toString('base64url') !== mac || !crypto.timingSafeEqual(supplied, signature(body, token))) {
    throw new Error('invalid agent message signature');
  }
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.toString('base64url') !== body) throw new Error('invalid agent message encoding');
  const packet = JSON.parse(bytes.toString('utf8'));
  validate(packet);
  if (!sameAddress(packet.target, target)) throw new Error('agent message target is stale or mismatched');
  return packet;
}

function issueAgentAddress(binding, token) {
  const address = Object.fromEntries(['guildId', 'channelId', 'provider', 'nativeId', 'generation'].map(key => [key, binding[key]]));
  if (!validAddress(address)) throw new Error('invalid agent address');
  const proof = crypto.createHmac('sha256', signingKey(token)).update('address/v1\0' + JSON.stringify(address)).digest('base64url');
  return { address, proof };
}

function verifyAgentAddress(envelope, token) {
  if (!exactKeys(envelope, ['address', 'proof']) || !validAddress(envelope.address) ||
      typeof envelope.proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(envelope.proof)) {
    throw new Error('agent target file must contain a complete binding address and proof');
  }
  const expected = issueAgentAddress(envelope.address, token);
  if (!crypto.timingSafeEqual(Buffer.from(envelope.proof), Buffer.from(expected.proof))) throw new Error('invalid agent address signature');
  return expected.address;
}

module.exports = { issueAgentAddress, verifyAgentAddress, KINDS, PREFIX, encodeAgentMessage, decodeAgentMessage, sameAddress, validAddress };
