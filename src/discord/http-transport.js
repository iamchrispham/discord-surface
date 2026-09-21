const path = require('node:path');
const { RECOVERY_LIMITS } = require('../state');
const { AGENT_ATTACHMENT_CONTENT_TYPE, AGENT_ATTACHMENT_FILENAME, AGENT_ATTACHMENT_MAX_BYTES } = require('../agent-attachment');
const { DIRECT_POST_FILE_LIMITS } = require('../direct-post-file');

function cancelResponseBody(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
}

async function readRetryAfter(response) {
  const headerValue = typeof response?.headers?.get === 'function'
    ? response.headers.get('retry-after') ?? response.headers.get('Retry-After')
    : response?.headers?.['retry-after'] ?? response?.headers?.['Retry-After'];
  const hasHeaderValue = headerValue !== null && headerValue !== undefined && String(headerValue).trim() !== '';
  const headerSeconds = hasHeaderValue ? Number(headerValue) : NaN;
  if (Number.isFinite(headerSeconds) && headerSeconds >= 0) {
    return { raw: headerValue, milliseconds: Math.ceil(headerSeconds * 1000) };
  }
  try {
    const body = await response?.json?.();
    const bodySeconds = Number(body?.retry_after);
    if (Number.isFinite(bodySeconds) && bodySeconds >= 0) {
      return { raw: body.retry_after, milliseconds: Math.ceil(bodySeconds * 1000) };
    }
  } catch {}
  return null;
}

async function sendDiscordMessage({ token, channelId, content, nonce, signal, timeoutMs = RECOVERY_LIMITS.timeoutMs,
  fetchImpl = globalThis.fetch, messageReference = null, allowedMentions = { parse: [] }, agentAttachment = null, fileAttachment = null, components = null }) {
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('Discord message fetch is unavailable'), { outcome: 'not_sent' });
  if (signal?.aborted) throw Object.assign(new Error('Discord message send stopped before request'), { outcome: 'not_sent' });
  if (agentAttachment !== null && (!Buffer.isBuffer(agentAttachment) || agentAttachment.length === 0 || agentAttachment.length > AGENT_ATTACHMENT_MAX_BYTES)) {
    throw Object.assign(new Error('agent attachment is outside the bounded wire limit'), { outcome: 'not_sent' });
  }
  if (agentAttachment !== null && fileAttachment !== null) throw Object.assign(new Error('Discord message cannot carry both attachment kinds'), { outcome: 'not_sent' });
  if (fileAttachment !== null && (!fileAttachment || !Buffer.isBuffer(fileAttachment.bytes) || fileAttachment.bytes.length > DIRECT_POST_FILE_LIMITS.maxBytes ||
      typeof fileAttachment.filename !== 'string' || !fileAttachment.filename || path.basename(fileAttachment.filename) !== fileAttachment.filename || fileAttachment.filename.length > 255)) {
    throw Object.assign(new Error('file attachment is outside the bounded wire limit'), { outcome: 'not_sent' });
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer;
  let started = false;
  const operation = (async () => {
    started = true;
    let response;
    try {
      const payload = {
        content, nonce, enforce_nonce: true, allowed_mentions: allowedMentions,
        ...(messageReference ? { message_reference: messageReference } : {}),
        ...(components ? { components } : {})
      };
      const request = {
        method: 'POST',
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': 'DiscordBot (discord-surface, 0.1.0)'
        },
        signal: controller.signal
      };
      if (agentAttachment === null && fileAttachment === null) {
        request.headers['Content-Type'] = 'application/json';
        request.body = JSON.stringify(payload);
      } else {
        if (typeof FormData !== 'function' || typeof Blob !== 'function') {
          throw Object.assign(new Error('multipart Discord message support is unavailable'), { outcome: 'not_sent' });
        }
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payload));
        const bytes = agentAttachment === null ? fileAttachment.bytes : agentAttachment;
        const filename = agentAttachment === null ? fileAttachment.filename : AGENT_ATTACHMENT_FILENAME;
        const contentType = agentAttachment === null ? DIRECT_POST_FILE_LIMITS.contentType : AGENT_ATTACHMENT_CONTENT_TYPE;
        form.append('files[0]', new Blob([bytes], { type: contentType }), filename);
        request.body = form;
      }
      response = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, request);
    } catch (error) {
      if (!error.outcome) error.outcome = started ? 'unknown' : 'not_sent';
      throw error;
    }
    if (!response?.ok) {
      await cancelResponseBody(response);
      const error = new Error('Discord direct post request rejected');
      error.status = response?.status;
      error.outcome = response?.status === 429 ? 'rate_limited' : [400, 401, 403, 404].includes(response?.status) ? 'not_sent' : 'unknown';
      throw error;
    }
    let body;
    try { body = await response.json(); }
    catch (error) { await cancelResponseBody(response); error.outcome = 'unknown'; throw error; }
    if (!body?.id) {
      await cancelResponseBody(response);
      throw Object.assign(new Error('Discord direct post response lacks message id'), { outcome: 'unknown' });
    }
    return body;
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('Discord direct post deadline exceeded'), { outcome: 'unknown' }));
    }, Math.max(1, Number(timeoutMs)));
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    operation.catch(() => {});
  }
}

async function fetchDiscordChannel({ token, channelId, signal, timeoutMs = RECOVERY_LIMITS.timeoutMs, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('Discord channel fetch is unavailable'), { outcome: 'not_sent' });
  if (signal?.aborted) throw Object.assign(new Error('Discord channel lookup stopped before request'), { outcome: 'not_sent' });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer;
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bot ${token}`,
          'User-Agent': 'DiscordBot (discord-surface, 0.1.0)'
        },
        signal: controller.signal
      });
    } catch (error) {
      if (!error.outcome) error.outcome = 'not_sent';
      throw error;
    }
    if (!response?.ok) {
      await cancelResponseBody(response);
      const error = new Error('Discord channel lookup request rejected');
      error.status = response?.status;
      error.outcome = response?.status === 429 ? 'rate_limited' : 'not_sent';
      throw error;
    }
    let body;
    try { body = await response.json(); }
    catch (error) { await cancelResponseBody(response); error.outcome = 'not_sent'; throw error; }
    if (typeof body?.id !== 'string' || typeof body?.guild_id !== 'string') {
      throw Object.assign(new Error('Discord channel response lacks destination identity'), { outcome: 'not_sent' });
    }
    return body;
  })();
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('Discord channel lookup deadline exceeded'), { outcome: 'not_sent' }));
    }, Math.max(1, Number(timeoutMs)));
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    operation.catch(() => {});
  }
}

module.exports = { cancelResponseBody, readRetryAfter, sendDiscordMessage, fetchDiscordChannel };
