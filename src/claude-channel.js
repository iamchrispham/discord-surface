const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');
const { MESSAGE_STATES, validateNativeId } = require('./state');

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
  constructor({ state, nativeId, socketPath, mcp, onTransportClose } = {}) {
    if (!state) throw new TypeError('state is required');
    validateNativeId(nativeId);
    assertSocketPath(socketPath);
    const binding = state.findNativeBinding(nativeId, 'claude');
    if (!binding || !binding.active || binding.provider !== 'claude' || binding.endpoint !== socketPath) {
      throw new Error('Claude channel requires a pre-bound, opted-in native session');
    }
    this.state = state;
    this.nativeId = nativeId;
    this.socketPath = socketPath;
    this.mcp = mcp || createDefaultMcp({ nativeId, state });
    this.server = null;
    this.ownsSocket = false;
    this.started = false;
    this.stopping = false;
    this.stopPromise = null;
    this.ready = false;
    this.transportClosed = false;
    this.onTransportClose = typeof onTransportClose === 'function' ? onTransportClose : null;
    this.mcp.onclose = () => {
      this.transportClosed = true;
      if (this.started && !this.stopPromise) this.stop().catch(() => {}).finally(() => this.onTransportClose?.());
    };
    this.mcp.onerror = () => {
      this.transportClosed = true;
      if (this.started && !this.stopPromise) this.stop().catch(() => {}).finally(() => this.onTransportClose?.());
    };
  }

  async handleEvent(body) {
    if (!this.ready) throw new Error('native Claude channel is not ready');
    validateNativeId(body.nativeId);
    if (body.nativeId !== this.nativeId) throw new Error('native session mismatch');
    if (typeof body.messageId !== 'string' || !body.messageId || !Number.isInteger(body.generation) || body.generation < 1 || typeof body.content !== 'string') {
      throw new Error('invalid Claude channel event');
    }
    const binding = this.state.findNativeBinding(this.nativeId, 'claude');
    const message = this.state.getMessage(body.messageId);
    if (!binding || !binding.active || binding.endpoint !== this.socketPath) throw new Error('stale Claude channel binding');
    if (binding.generation !== body.generation) throw new Error('stale Claude channel generation');
    if (!message || message.provider !== 'claude' || message.nativeId !== body.nativeId || message.generation !== body.generation ||
      ![MESSAGE_STATES.DISPATCHING, MESSAGE_STATES.SUBMITTED].includes(message.state)) {
      throw new Error('Claude channel event has no accepted custody');
    }
    this.state.assertMessageCurrent(body.messageId, 'native-dispatch');
    try {
      await this.mcp.notification({ method: 'notifications/claude/channel', params: {
        content: body.content,
        meta: { messageId: body.messageId, generation: body.generation, nativeId: body.nativeId }
      }});
    } catch (error) {
      error.potentiallyDelivered = true;
      throw error;
    }
  }

  async start() {
    if (this.started) return;
    if (this.stopPromise) await this.stopPromise;
    this.transportClosed = false;
    prepareSocket(this.socketPath);
    try {
      if (typeof this.mcp.connect === 'function') await this.mcp.connect(this.mcp.transportFactory());
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
          const status = !this.ready ? 503 : error.potentiallyDelivered ? 503 : /custody|stale|mismatch|generation|authorization/i.test(error.message) ? 409 : 400;
          response.writeHead(status);
          response.end(status === 503 ? 'uncertain' : 'rejected');
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
      if (this.transportClosed) throw new Error('Claude channel transport closed during startup');
      this.ready = true;
      this.started = true;
    } catch (error) {
      this.ready = false;
      try { await this.mcp.close?.(); } catch {}
      try { this.server?.close(); } catch {}
      this.server = null;
      if (this.ownsSocket) {
        try { fs.unlinkSync(this.socketPath); } catch {}
        this.ownsSocket = false;
      }
      throw error;
    }
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      this.ready = false;
      const errors = [];
      try { await this.mcp.close?.(); } catch (error) { errors.push(error); }
      try {
        if (this.server) await new Promise((resolve, reject) => {
          this.server.close(error => error ? reject(error) : resolve());
        });
      } catch (error) { errors.push(error); }
      this.server = null;
      if (this.ownsSocket) {
        try { fs.unlinkSync(this.socketPath); } catch (error) { if (error.code !== 'ENOENT') errors.push(error); }
        this.ownsSocket = false;
      }
      this.started = false;
      this.stopping = false;
      if (errors.length) throw new AggregateError(errors, 'Claude channel stop failed');
    })();
    try { await this.stopPromise; } finally { this.stopPromise = null; }
  }
}

module.exports = {
  ClaudeChannel,
  assertSocketPath,
  createDefaultMcp,
  parseBody,
  prepareSocket
};
