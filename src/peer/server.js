'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { readSecret } = require('../discord');
const { createPeerService } = require('./service');
const { PEER_PACKET_ID_SCHEMA } = require('./result');

const packetId = PEER_PACKET_ID_SCHEMA;

const selector = { oneOf: [
  { type: 'object', properties: { repoKey: { type: 'string' }, provider: { enum: ['codex', 'claude'] } }, required: ['repoKey', 'provider'], additionalProperties: false },
  { type: 'object', properties: { conductorId: { type: 'string' } }, required: ['conductorId'], additionalProperties: false },
  { type: 'object', properties: { channelId: { type: 'string' } }, required: ['channelId'], additionalProperties: false },
  { type: 'object', properties: { channelName: { type: 'string' } }, required: ['channelName'], additionalProperties: false }
] };
const postInputSchema = { type: 'object', properties: { role: { enum: ['announce', 'board', 'child'] }, text_file: { type: 'string' },
  dedupe_key: { type: 'string' }, message_id: { type: 'string' }, peer: selector, reply_to: packetId },
  required: ['role', 'text_file', 'dedupe_key'], additionalProperties: false, oneOf: [
    { properties: { role: { const: 'announce' } }, required: ['role'],
      not: { anyOf: [{ required: ['message_id'] }, { required: ['peer'] }, { required: ['reply_to'] }] } },
    { properties: { role: { const: 'board' } }, required: ['role', 'message_id'],
      not: { anyOf: [{ required: ['peer'] }, { required: ['reply_to'] }] } },
    { properties: { role: { const: 'child' }, dedupe_key: packetId, peer: selector, reply_to: packetId }, required: ['role'],
      not: { required: ['message_id'] }, oneOf: [
        { required: ['peer'], not: { required: ['reply_to'] } },
        { required: ['reply_to'], not: { required: ['peer'] } }
      ] }
  ] };
const tools = [
  { name: 'post', description: 'Post an announcement to the caller parent, update a known board message, or send an authenticated child packet. Board requires message_id. Child requires peer or reply_to.',
    inputSchema: postInputSchema },
  { name: 'peer_result', description: 'Inspect caller-scoped send, native pickup and completion evidence without changing custody.',
    inputSchema: { type: 'object', properties: { correlation_id: packetId }, required: ['correlation_id'], additionalProperties: false } },
  { name: 'peer_list', description: 'List current bindings and whether each has one ready enrolled child.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'peer_send', description: 'Send an authenticated agent request to a current peer, or a result using reply_to. Reuse dedupe_key on retry. Sent is not native pickup or completion.',
    inputSchema: { type: 'object', properties: { peer: selector, reply_to: packetId, text: { type: 'string' }, text_file: { type: 'string' }, dedupe_key: packetId },
      required: ['dedupe_key'], additionalProperties: false, allOf: [
        { oneOf: [
          { required: ['text'], not: { required: ['text_file'] } },
          { required: ['text_file'], not: { required: ['text'] } }
        ] },
        { oneOf: [
          { required: ['peer'], not: { required: ['reply_to'] } },
          { required: ['reply_to'], not: { required: ['peer'] } }
        ] }
      ] } }
];

function createPeerMcp(service) {
  const server = new Server({ name: 'discord-surface-peers', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }, extra) => {
    try {
      let result;
      if (params.name === 'peer_list') {
        if (Object.keys(params.arguments || {}).length) throw new Error('peer_list takes no arguments');
        result = await service.list(extra.signal);
      } else if (params.name === 'peer_result') {
        if (Object.keys(params.arguments || {}).some(key => key !== 'correlation_id')) throw new Error('invalid peer_result arguments');
        result = await service.result(params.arguments?.correlation_id, extra.signal);
      } else if (params.name === 'post') {
        result = await service.post(params.arguments, extra.signal);
      } else if (params.name === 'peer_send') {
        result = await service.send(params.arguments, extra.signal);
      } else throw new Error('unknown peer tool');
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  return server;
}

async function startPeerMcp(args) {
  if (!['codex', 'claude'].includes(args.provider)) throw new Error('mcp requires --provider codex or claude');
  const { state, paths } = require('../cli').openState(args);
  const stop = new AbortController();
  const pending = new Set();
  let server;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    stop.abort();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await Promise.allSettled([...pending]);
    state.close();
  };
  const onSignal = () => { stop.abort(); void server.close().finally(close); };
  try {
    const config = state.requireConfig();
    const token = readSecret(config.secretFile);
    const service = createPeerService({ state, provider: args.provider, token, stateDir: paths.stateDir,
      loadChannels: async signal => {
        const response = await fetch(`https://discord.com/api/v10/guilds/${config.guildId}/channels`, {
          headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.any([signal, stop.signal, AbortSignal.timeout(30000)].filter(Boolean))
        });
        if (!response.ok) throw new Error(`peer channel lookup refused: HTTP ${response.status}`);
        const channels = await response.json();
        if (!Array.isArray(channels)) throw new Error('peer channel lookup returned invalid data');
        return channels.map(channel => ({ id: channel.id, guildId: channel.guild_id, name: channel.name }));
      }
    });
    const tracked = Object.fromEntries(['list', 'send', 'result', 'post'].map(name => [name, (...values) => {
      if (stop.signal.aborted) return Promise.reject(new Error('peer server is closing'));
      const requestSignal = name === 'list' ? values[0] : values[1];
      const signal = AbortSignal.any([requestSignal, stop.signal].filter(Boolean));
      if (name === 'list') values[0] = signal;
      else values[1] = signal;
      const promise = Promise.resolve().then(() => service[name](...values));
      pending.add(promise);
      promise.then(() => pending.delete(promise), () => pending.delete(promise));
      return promise;
    }]));
    server = createPeerMcp(tracked);
    server.onclose = () => { void close(); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    await server.connect(new StdioServerTransport());
    return server;
  } catch (error) { await close(); throw error; }
}

module.exports = { createPeerMcp, startPeerMcp };
