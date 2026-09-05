const fs = require('node:fs');
const http = require('node:http');
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { MESSAGE_STATES, PROVIDERS, validateNativeId } = require('./state');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function codexPrompt(message) {
  const marker = `[[discord-surface:${message.id}]]`;
  return [
    `This is an inbound Discord message for native session ${message.nativeId}.`,
    `Transport message ID: ${message.id}. Ownership generation: ${message.generation}.`,
    `Begin the final response with the exact marker ${marker} on its own line. The transport removes that marker before sending the reply.`,
    'Answer the user request in your normal final response. Do not start another session or hand this work to another agent.',
    '',
    message.content
  ].join('\n');
}

function claudeEvent(message) {
  return {
    nativeId: message.nativeId,
    messageId: message.id,
    generation: message.generation,
    content: [
      `Inbound Discord message ${message.id} for native Claude session ${message.nativeId}.`,
      `Use the reply tool with messageId "${message.id}" and generation ${message.generation} after you have answered.`,
      'Do not start or resume another session.',
      '',
      message.content
    ].join('\n')
  };
}

function sessionRoot() {
  const home = os.homedir();
  return path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
}

function walk(dir, result = [], depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) return result;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, result, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(full);
  }
  return result;
}

function findCodexSessionFile(nativeId, root = sessionRoot()) {
  for (const file of walk(root)) {
    if (!file.includes(nativeId)) continue;
    try {
      const line = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
      const row = JSON.parse(line);
      if (row.type === 'session_meta' && (row.payload?.session_id || row.payload?.id) === nativeId) return file;
    } catch {}
  }
  return null;
}

function finalText(row, marker) {
  const payload = row.payload;
  let item = null;
  let phase = null;
  if (row.type === 'event_msg' && payload?.type === 'item_completed') {
    item = payload.item;
    phase = item?.phase;
  } else if (row.type === 'response_item' && payload?.type === 'message') {
    item = payload;
    phase = payload.phase;
  }
  if (!item || phase !== 'final_answer') return null;
  const text = (item.content || [])
    .filter(part => part.type === 'Text' || part.type === 'output_text')
    .map(part => part.text)
    .filter(value => typeof value === 'string')
    .join('')
    .trim();
  if (!text || !text.includes(marker)) return null;
  const reply = text.slice(text.indexOf(marker) + marker.length).trim();
  return reply || null;
}

async function observeCodexReply(nativeId, cursor, { marker, timeoutMs = 120000, root = sessionRoot(), pollMs = 250 } = {}) {
  if (!marker) throw new Error('Codex observer requires a unique response marker');
  const startedAt = Date.now();
  let file = cursor?.file || findCodexSessionFile(nativeId, root);
  let offset = Number(cursor?.offset || 0);
  while (Date.now() - startedAt < timeoutMs) {
    if (!file) file = findCodexSessionFile(nativeId, root);
    if (file) {
      try {
        const content = fs.readFileSync(file, 'utf8');
        const chunk = content.slice(offset);
        offset = content.length;
        for (const line of chunk.split('\n')) {
          if (!line) continue;
          try {
            const row = JSON.parse(line);
            if (Date.parse(row.timestamp || '') < (cursor?.since || startedAt)) continue;
            const text = finalText(row, marker);
            if (text) return { text, cursor: { file, offset } };
          } catch {}
        }
      } catch {}
    }
    await sleep(pollMs);
  }
  return null;
}

function readInitialCursor(nativeId, root = sessionRoot()) {
  const file = findCodexSessionFile(nativeId, root);
  if (!file) return { file: null, offset: 0, since: Date.now() };
  let offset = 0;
  try { offset = fs.statSync(file).size; } catch {}
  return { file, offset, since: Date.now() };
}

function runCodex(command, args, options = {}) {
  return new Promise(resolve => {
    let spawned = false;
    const child = execFile(command, args, { cwd: options.cwd, env: process.env, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ status: 'submitted', stdout, stderr });
      const text = `${error.message} ${stderr || ''}`;
      if (!spawned || error.code === 'ENOENT') return resolve({ status: 'not_submitted', error: new Error(text) });
      if (/not found|does not exist|unknown thread|no such thread|missing thread/i.test(text)) {
        return resolve({ status: 'not_submitted', error: new Error(text) });
      }
      resolve({ status: 'uncertain', error: new Error(text) });
    });
    spawned = true;
    child.once('error', error => {
      if (error.code === 'ENOENT') resolve({ status: 'not_submitted', error });
      else resolve({ status: 'uncertain', error });
    });
  });
}

class CodexProvider {
  constructor({ command = 'codex', root = sessionRoot(), run = runCodex } = {}) {
    this.command = command;
    this.root = root;
    this.run = run;
  }

  async dispatch(message) {
    try { validateNativeId(message.nativeId); } catch (error) {
      return { status: 'not_submitted', error };
    }
    const cursor = readInitialCursor(message.nativeId, this.root);
    const args = ['queue', '--thread', message.nativeId, '--message', codexPrompt(message), '--cd', message.workspace];
    const result = await this.run(this.command, args, { cwd: message.workspace });
    return { ...result, cursor };
  }

  observe(message, outcome, options) {
    return observeCodexReply(message.nativeId, outcome.cursor, { ...options, marker: `[[discord-surface:${message.id}]]`, root: this.root });
  }
}

function postUnixJson(socketPath, body, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(JSON.stringify(body));
    let wrote = false;
    const request = http.request({ socketPath, path: '/event', method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': encoded.length } }, response => {
      let output = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { output += chunk; });
      response.on('end', () => resolve({ statusCode: response.statusCode, body: output, wrote }));
    });
    request.on('timeout', () => request.destroy(new Error('native channel request timed out')));
    request.on('error', error => { error.wrote = wrote; reject(error); });
    request.write(encoded, () => { wrote = true; });
    request.end();
  });
}

class ClaudeProvider {
  constructor({ post = postUnixJson, waitForReply } = {}) {
    this.post = post;
    this.waitForReply = waitForReply;
  }

  async dispatch(message) {
    try { validateNativeId(message.nativeId); } catch (error) {
      return { status: 'not_submitted', error };
    }
    if (!message.endpoint) return { status: 'not_submitted', error: new Error('Claude binding has no native channel endpoint') };
    try {
      const result = await this.post(message.endpoint, claudeEvent(message));
      if (result.statusCode === 202) return { status: 'submitted' };
      if (result.statusCode >= 400 && result.statusCode < 500) return { status: 'not_submitted', error: new Error(`Claude channel rejected event: ${result.statusCode}`) };
      return { status: 'uncertain', error: new Error(`Claude channel returned ${result.statusCode}`) };
    } catch (error) {
      return { status: error.wrote ? 'uncertain' : 'not_submitted', error };
    }
  }

  observe(message, outcome, options) {
    if (!this.waitForReply) return null;
    return this.waitForReply(message.id, options);
  }
}

async function waitForReply(state, messageId, { timeoutMs = 120000, pollMs = 250 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = state.getMessage(messageId);
    if (!message) return null;
    if (message.state === MESSAGE_STATES.REPLY_READY || message.state === MESSAGE_STATES.REPLIED) {
      return { text: message.replyText };
    }
    if ([MESSAGE_STATES.UNCERTAIN, MESSAGE_STATES.REPLY_UNKNOWN].includes(message.state)) return null;
    await sleep(pollMs);
  }
  return null;
}

async function dispatchAndObserve(state, messageId, providers, options = {}) {
  let claimed;
  try {
    claimed = state.claimDispatch(messageId);
  } catch (error) {
    return { status: 'rejected', message: state.getMessage(messageId), error };
  }
  if (!claimed.claimed) return { status: claimed.message?.state || 'ignored', message: claimed.message };
  const message = claimed.message;
  const provider = providers[message.provider];
  if (!provider) {
    const error = new Error(`provider is not configured: ${message.provider}`);
    state.markUncertain(message.id, error);
    return { status: 'uncertain', message: state.getMessage(message.id), error };
  }
  let outcome;
  try {
    outcome = await provider.dispatch(message);
  } catch (error) {
    state.markUncertain(message.id, error);
    return { status: 'uncertain', message: state.getMessage(message.id), error };
  }
  if (!outcome || !['submitted', 'not_submitted', 'uncertain'].includes(outcome.status)) {
    const error = new Error('native dispatcher returned an invalid outcome');
    state.markUncertain(message.id, error);
    return { status: 'uncertain', message: state.getMessage(message.id), error };
  }
  if (outcome.status === 'not_submitted') {
    state.markNotSubmitted(message.id, outcome.error);
    return { status: 'not_submitted', message: state.getMessage(message.id), error: outcome.error };
  }
  if (outcome.status === 'uncertain') {
    state.markUncertain(message.id, outcome.error);
    return { status: 'uncertain', message: state.getMessage(message.id), error: outcome.error };
  }
  state.markSubmitted(message.id);
  let reply;
  try {
    reply = await provider.observe?.(message, outcome, options);
  } catch (error) {
    return { status: 'submitted', message: state.getMessage(message.id), error };
  }
  if (reply?.text) {
    try {
      state.recordNativeReply({ messageId: message.id, nativeId: message.nativeId, generation: message.generation, text: reply.text });
    } catch (error) {
      return { status: 'stale-reply', message: state.getMessage(message.id), error };
    }
  }
  const saved = state.getMessage(message.id);
  return { status: saved.state, message: saved };
}

module.exports = {
  ClaudeProvider,
  CodexProvider,
  claudeEvent,
  codexPrompt,
  dispatchAndObserve,
  findCodexSessionFile,
  observeCodexReply,
  postUnixJson,
  readInitialCursor,
  runCodex,
  waitForReply
};
