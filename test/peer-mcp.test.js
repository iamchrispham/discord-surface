const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { fixture } = require('./fixtures/peer-fixture');

test('public MCP stdio omits the caller and refuses an unready send', { timeout: 15000 }, async t => {
  const f = fixture(t);
  f.state.db.prepare("UPDATE bindings SET provider='codex'").run();
  const config = f.state.requireConfig();
  fs.writeFileSync(config.secretFile, 'DISCORD_TOKEN=fixture\n', { mode: 0o600 });
  const childDeadline = path.join(path.dirname(config.secretFile), 'child-deadline.cjs');
  fs.writeFileSync(childDeadline, 'setTimeout(() => process.exit(124), 12000).unref();\n');
  const client = new Client({ name: 'peer-fixture', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', '--require', childDeadline, path.resolve(__dirname, '../src/cli.js'), 'mcp', '--provider', 'codex', '--db', path.join(path.dirname(config.secretFile), 'surface.sqlite')],
    env: { ...process.env, CODEX_THREAD_ID: '11111111-1111-1111-1111-111111111111', CODEX_SESSION_ID: '11111111-1111-1111-1111-111111111111' }, stderr: 'pipe' });
  const deadline = setTimeout(() => { void transport.close(); }, 10000);
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(tool => tool.name), ['post', 'peer_result', 'peer_list', 'peer_send']);
    const postSchema = tools.find(tool => tool.name === 'post').inputSchema;
    const peerSendSchema = tools.find(tool => tool.name === 'peer_send').inputSchema;
    const childSchema = postSchema.oneOf.find(branch => branch.properties.role.const === 'child');
    const announceSchema = postSchema.oneOf.find(branch => branch.properties.role.const === 'announce');
    const boardSchema = postSchema.oneOf.find(branch => branch.properties.role.const === 'board');
    assert.deepEqual(childSchema.properties.reply_to, peerSendSchema.properties.reply_to);
    assert.deepEqual(childSchema.oneOf.map(branch => branch.required), [['peer'], ['reply_to']]);
    assert.deepEqual(announceSchema.not.anyOf.map(branch => branch.required), [['message_id'], ['peer'], ['reply_to']]);
    assert.deepEqual(boardSchema.required, ['role', 'message_id']);
    assert.deepEqual(boardSchema.not.anyOf.map(branch => branch.required), [['peer'], ['reply_to']]);
    assert.equal(postSchema.properties.dedupe_key.type, 'string');
    assert.equal(postSchema.properties.dedupe_key.maxLength, 256);
    assert.equal(postSchema.properties.message_id.maxLength, 128);
    assert.equal(postSchema.properties.reply_to.type, 'string');
    assert.equal(postSchema.properties.text_file.maxLength, 4096);
    assert.equal(peerSendSchema.properties.dedupe_key.maxLength, 128);
    assert.equal(peerSendSchema.properties.text_file.maxLength, 4096);
    assert.deepEqual(peerSendSchema.allOf.map(branch => branch.oneOf.map(option => option.required)), [
      [['text'], ['text_file']], [['peer'], ['reply_to']]
    ]);
    for (const property of ['text', 'text_file']) {
      const pattern = new RegExp(peerSendSchema.properties[property].pattern);
      assert.equal(pattern.test(' '), false);
      assert.equal(pattern.test('payload'), true);
    }
    assert.equal(peerSendSchema.properties.text.not, undefined);
    const textPattern = new RegExp(peerSendSchema.properties.text.pattern);
    assert.equal(textPattern.test('first line\nsecond line'), true);
    assert.equal(textPattern.test('\t\n'), false);
    const listed = await client.callTool({ name: 'peer_list', arguments: {} });
    const peers = JSON.parse(listed.content[0].text);
    assert.deepEqual(peers, []);
    const before = f.state.listReceipts().length;
    const refused = await client.callTool({ name: 'peer_send', arguments: {
      peer: { conductorId: 'test-conductor' }, text: 'hello', dedupe_key: 'public-fixture'
    } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /no enrolled child/);
    assert.equal(f.state.listReceipts().length, before);
  } finally { clearTimeout(deadline); await client.close(); await transport.close(); }
});
