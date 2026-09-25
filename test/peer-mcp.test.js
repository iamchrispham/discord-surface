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
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['post', 'peer_result', 'peer_list', 'peer_send']);
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
