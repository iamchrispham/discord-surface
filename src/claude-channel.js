const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { validateNativeId } = require('./state');

const requireInstalled = createRequire('/Users/cphamballer/.codex/mcp/discord/package.json');

function parseBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 20000) request.destroy(new Error('request too large'));
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid JSON')); }
    });
    request.on('error', reject);
  });
}

function assertSocketPath(socketPath) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) throw new Error('Claude channel socket must be an absolute path');
  if (socketPath.length > 90) throw new Error('Claude channel socket path is too long for macOS');
}

function prepareSocket(socketPath) {
  assertSocketPath(socketPath);
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const mode = fs.statSync(path.dirname(socketPath)).mode & 0o777;
  if (mode & 0o077) throw new Error('Claude channel socket directory must be owner-only');
  if (fs.existsSync(socketPath)) {
    if (!fs.lstatSync(socketPath).isSocket()) throw new Error('Claude channel path exists and is not a socket');
    throw new Error('Claude channel socket already exists; stop its owner first');
  }
}

function createDefaultMcp({ nativeId, state }) {
  const { Server } = requireInstalled('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = requireInstalled('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = requireInstalled('@modelcontextprotocol/sdk/types.js');
  const mcp = new Server(
    { name: 'discord-surface-claude-channel', version: '0.1.0' },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions: 'This channel is explicitly opted in by the native Claude session. For each event, answer the user and call reply with the exact messageId and generation from the event. Do not attach, resume, or start another session.'
    }
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'reply',
      description: 'Persist the final answer for the exact Discord message and ownership generation.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          generation: { type: 'integer', minimum: 1 },
          text: { type: 'string', minLength: 1, maxLength: 10000 }
        },
        required: ['messageId', 'generation', 'text'],
        additionalProperties: false
      }
    }]
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name !== 'reply') throw new Error('unknown Claude channel tool');
    const args = params.arguments || {};
    const result = state.recordNativeReply({ messageId: args.messageId, nativeId, generation: args.generation, text: args.text });
    return { content: [{ type: 'text', text: result.duplicate ? 'Already recorded.' : 'Recorded.' }] };
  });
  mcp.transportFactory = () => new StdioServerTransport();
  return mcp;
}

class ClaudeChannel {
  constructor({ state, nativeId, socketPath, mcp } = {}) {
    if (!state) throw new TypeError('state is required');
    validateNativeId(nativeId);
    assertSocketPath(socketPath);
    const binding = state.findNativeBinding(nativeId);
    if (!binding || binding.provider !== 'claude' || binding.endpoint !== socketPath) {
      throw new Error('Claude channel requires a pre-bound, opted-in native session');
    }
    this.state = state;
    this.nativeId = nativeId;
    this.socketPath = socketPath;
    this.mcp = mcp || createDefaultMcp({ nativeId, state });
    this.server = null;
    this.ownsSocket = false;
    this.started = false;
  }

  async handleEvent(body) {
    validateNativeId(body.nativeId);
    if (body.nativeId !== this.nativeId) throw new Error('native session mismatch');
    if (typeof body.messageId !== 'string' || !body.messageId || !Number.isInteger(body.generation) || body.generation < 1 || typeof body.content !== 'string') {
      throw new Error('invalid Claude channel event');
    }
    const binding = this.state.findNativeBinding(this.nativeId);
    if (!binding || binding.endpoint !== this.socketPath) throw new Error('stale Claude channel binding');
    if (binding.generation !== body.generation) throw new Error('stale Claude channel generation');
    await this.mcp.notification({ method: 'notifications/claude/channel', params: {
      content: body.content,
      meta: { messageId: body.messageId, generation: body.generation, nativeId: body.nativeId }
    }});
  }

  async start() {
    if (this.started) return;
    prepareSocket(this.socketPath);
    this.server = http.createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/event') {
        response.writeHead(404);
        response.end();
        return;
      }
      try {
        await this.handleEvent(await parseBody(request));
        response.writeHead(202);
        response.end('accepted');
      } catch (error) {
        response.writeHead(400);
        response.end('rejected');
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        try { fs.chmodSync(this.socketPath, 0o600); } catch {}
        this.ownsSocket = true;
        resolve();
      });
    });
    if (typeof this.mcp.connect === 'function') await this.mcp.connect(this.mcp.transportFactory());
    this.started = true;
  }

  async stop() {
    if (this.server) await new Promise(resolve => this.server.close(() => resolve()));
    if (this.ownsSocket) {
      try { fs.unlinkSync(this.socketPath); } catch {}
      this.ownsSocket = false;
    }
    if (typeof this.mcp.close === 'function') await this.mcp.close();
    this.started = false;
  }
}

module.exports = {
  ClaudeChannel,
  assertSocketPath,
  createDefaultMcp,
  parseBody,
  prepareSocket
};
