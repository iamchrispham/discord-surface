const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createOrdinaryClaudeRequest, ordinaryBindingDecision, resolveExistingChannel } = require('../../src/ordinary-codex');
const { validateClaudeSessionIdentity } = require('../../src/native');
const { OTHER, CLAUDE, fixture, transcript } = require('./fixture.cjs');

test('ordinary Claude request requires exact harness, UUID, endpoint, and transcript workspace', t => {
  const f = fixture(t, { bind: false });
  const proof = validateClaudeSessionIdentity(CLAUDE, f.session.file);
  assert.equal(proof.sessionId, CLAUDE);
  assert.equal(proof.threadId, CLAUDE);
  assert.equal(proof.workspace, f.dir);
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, f.session.file, '/tmp/other-workspace'), /does not match/);
  const wrong = transcript(t, f.dir, OTHER);
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, wrong.file), /identity or workspace/);
  assert.throws(() => createOrdinaryClaudeRequest({
    channelId: 'channel', guildId: 'guild', nativeId: OTHER, workspace: f.dir, endpoint: f.socketPath,
    identity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' }
  }), /conflicts/);
  assert.throws(() => createOrdinaryClaudeRequest({
    channelId: 'channel', guildId: 'guild', workspace: f.dir, endpoint: f.socketPath,
    identity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'codex' }
  }), /harness/);
});

test('ordinary Claude accepts single or equal transcript IDs and rejects conflicts', t => {
  const f = fixture(t, { bind: false });
  const metadata = { cwd: f.dir, entrypoint: 'cli', version: '1.0.0' };
  const write = (name, row) => {
    const file = path.join(f.dir, name);
    fs.writeFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    return file;
  };
  const topLevel = write('top-level.jsonl', { ...metadata, sessionId: CLAUDE });
  const payloadOnly = write('payload-only.jsonl', { ...metadata, payload: { session_id: CLAUDE } });
  const equalAliases = write('equal-aliases.jsonl', { ...metadata, sessionId: CLAUDE, payload: { session_id: CLAUDE } });
  const conflicting = write('conflicting-aliases.jsonl', { ...metadata, sessionId: CLAUDE, payload: { session_id: OTHER } });
  const lateConflict = path.join(f.dir, 'late-conflict.jsonl');
  fs.writeFileSync(lateConflict, [
    ...Array.from({ length: 5000 }, () => ({ ...metadata, sessionId: CLAUDE })),
    { ...metadata, sessionId: OTHER }
  ].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  assert.equal(validateClaudeSessionIdentity(CLAUDE, topLevel).sessionId, CLAUDE);
  assert.equal(validateClaudeSessionIdentity(CLAUDE, payloadOnly).sessionId, CLAUDE);
  assert.equal(validateClaudeSessionIdentity(CLAUDE, equalAliases).sessionId, CLAUDE);
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, conflicting), /Claude transcript identity is ambiguous/);
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, lateConflict), /identity is ambiguous/);

  const growing = write('growing.jsonl', { ...metadata, sessionId: CLAUDE });
  const realReadSync = fs.readSync;
  let appended = false;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    const count = realReadSync(fd, buffer, offset, length, position);
    if (!appended) {
      appended = true;
      fs.appendFileSync(growing, `${JSON.stringify({ ...metadata, sessionId: OTHER })}\n`);
    }
    return count;
  });
  assert.equal(validateClaudeSessionIdentity(CLAUDE, growing).sessionId, CLAUDE);
});

test('ordinary Claude rejects a transcript shortened during metadata scanning', t => {
  const f = fixture(t, { bind: false });
  fs.appendFileSync(f.session.file, 'x'.repeat(70 * 1024));
  const realReadSync = fs.readSync;
  let reads = 0;
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    reads += 1;
    if (reads === 2) return 0;
    return realReadSync(fd, buffer, offset, length, position);
  });
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, f.session.file), /transcript shortened during read/);
});

test('oversized Claude metadata records fail closed', t => {
  const f = fixture(t, { bind: false });
  const file = path.join(f.dir, 'oversized-conflict.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ cwd: f.dir, entrypoint: 'cli', version: '1.0.0', sessionId: OTHER, filler: 'x'.repeat(1024 * 1024) }),
    JSON.stringify({ cwd: f.dir, entrypoint: 'cli', version: '1.0.0', sessionId: CLAUDE })
  ].join('\n') + '\n', { mode: 0o600 });
  assert.throws(() => validateClaudeSessionIdentity(CLAUDE, file), /record is too large/);
});

test('ordinary Claude selection and same-owner decision preserve channel custody', () => {
  const channels = [
    { id: '123', guildId: 'guild', name: 'ops', messageCapable: true },
    { id: '456', guildId: 'guild', name: 'dev', messageCapable: true },
    { id: '789', guildId: 'other', name: 'ops', messageCapable: true },
    { id: 'cat', guildId: 'guild', name: 'category', messageCapable: false }
  ];
  assert.equal(resolveExistingChannel('123', 'guild', channels).id, '123');
  assert.equal(resolveExistingChannel('<#456>', 'guild', channels).id, '456');
  assert.equal(resolveExistingChannel('#dev', 'guild', channels).id, '456');
  assert.throws(() => resolveExistingChannel('<#789>', 'guild', channels), /outside/);
  assert.throws(() => resolveExistingChannel('#category', 'guild', channels), /message-capable/);
  const request = {
    provider: 'claude', channelId: 'channel', guildId: 'guild', nativeId: CLAUDE, workspace: '/tmp/workspace', endpoint: '/tmp/claude.sock',
    identity: { sessionId: CLAUDE, threadId: CLAUDE, harness: 'claude-code' }
  };
  assert.equal(ordinaryBindingDecision(null, request), 'bind');
  assert.equal(ordinaryBindingDecision({ ...request, active: true }, request, true), 'reuse');
  assert.equal(ordinaryBindingDecision({ ...request, active: false }, request, true), 'rebind');
  assert.throws(() => ordinaryBindingDecision({ ...request, endpoint: '/tmp/other.sock', active: true }, request, true), /already bound/);
  assert.throws(() => ordinaryBindingDecision({ ...request, conductorId: 'owner', active: true }, request, false), /already bound/);
  const foreign = { ...request, nativeId: OTHER, identity: { sessionId: OTHER, threadId: OTHER, harness: 'claude-code' } };
  assert.throws(() => ordinaryBindingDecision({ ...request, active: true }, foreign, true), error => {
    assert.match(error.message, /Claude owner replacement requires an explicit supported handoff/);
    assert.doesNotMatch(error.message, /provider codex/);
    return true;
  });
});
