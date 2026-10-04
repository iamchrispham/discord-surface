'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Runtime harness for the shared effect owners.


function refusalError() {
  return new Error('native caller must be revalidated: peer caller changed');
}

function buildHarness({ snapshot, rejectWhen = null }) {
  const events = [];
  let fetchCount = 0;
  const assertCallerCurrent = async () => {
    const state = snapshot();
    events.push({ kind: 'assert', snapshot: state });
    if (rejectWhen && rejectWhen({ fetchCount, snapshot: state, events })) throw refusalError();
  };
  const wrapFetch = inner => async (url, init = {}) => {
    fetchCount += 1;
    events.push({ kind: 'fetch', method: init.method || 'GET', url });
    return inner(url, init);
  };
  return { events, assertCallerCurrent, wrapFetch, fetchCount: () => fetchCount };
}

function directSnapshot(state, requestId) {
  const rows = state.directPostRows(requestId);
  return {
    attempts: rows.filter(row => row.kind === 'direct-post-attempt').length,
    outcomes: rows.filter(row => row.kind === 'direct-post-outcome'),
    sent: rows.some(row => row.kind === 'direct-post-outcome' && row.detail.outcome === 'sent'),
    unknown: rows.some(row => row.kind === 'direct-post-outcome' && row.detail.outcome === 'unknown'),
    preflight: rows.filter(row => row.kind === 'direct-post-outcome' && row.detail.phase === 'preflight')
  };
}

function boardSnapshot(state, requestId) {
  const rows = state.listReceipts()
    .map(row => ({ kind: row.kind, detail: JSON.parse(row.detail) }))
    .filter(row => row.kind.startsWith('board-refresh') && row.detail.requestId === requestId);
  return {
    attempts: rows.filter(row => row.kind === 'board-refresh-attempt'),
    outcomes: rows.filter(row => row.kind === 'board-refresh-outcome'),
    applied: rows.some(row => row.kind === 'board-refresh-outcome' && row.detail.outcome === 'applied')
  };
}

function fetchEventIndex(events, method) {
  return events.findIndex(event => event.kind === 'fetch' && event.method === method);
}

function assertBracketed(events, method) {
  const index = fetchEventIndex(events, method);
  assert.ok(index > 0, `a ${method} request must be preceded by a caller assertion`);
  const before = events.slice(0, index).some(event => event.kind === 'assert');
  const after = events.slice(index + 1).some(event => event.kind === 'assert');
  assert.equal(before, true, `caller assertion before ${method}`);
  assert.equal(after, true, `caller assertion after ${method}`);
  return index;
}

// ---------------------------------------------------------------------------

async function boardRun(f, content, requestId, harness, board, hooks = {}) {
  const { runBoardRefresh } = require('../../src/board-refresh');
  const { response } = require('../board-refresh-fixture');
  fs.writeFileSync(f.textFile, content);
  const binding = f.state.getBinding('channel-1');
  const fetchImpl = harness.wrapFetch(async (url, init = {}) => {
    if (url.endsWith('/users/@me')) { hooks.onGet?.('installation'); return response({ id: 'bot-1' }); }
    if (init.method === 'GET' && url.endsWith('/channels/channel-1')) { hooks.onGet?.('channel'); return response({ id: 'channel-1', guild_id: 'guild-1' }); }
    if (init.method === 'GET') { hooks.onGet?.('target'); return response({ id: 'target-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content }); }
    if (init.method === 'PATCH') {
      hooks.onPatch?.();
      const body = JSON.parse(init.body);
      board.content = body.content;
      return response({ id: 'target-1', channel_id: 'channel-1', author: { id: 'bot-1', bot: true }, content: board.content });
    }
    hooks.onAny?.();
    throw new Error(`unexpected board request ${init.method} ${url}`);
  });
  try {
    return await runBoardRefresh({
      state: f.state,
      token: 'fixture-token',
      nativeId: binding.nativeId,
      generation: binding.generation,
      channelId: 'channel-1',
      messageId: 'target-1',
      textFile: f.textFile,
      dedupeKey: requestId,
      fetchImpl,
      timeoutMs: 1000,
      resolveBinding: state => state.getBinding('channel-1'),
      assertCallerCurrent: harness.assertCallerCurrent
    });
  } finally {
    hooks.onAny?.();
  }
}

function boardFixtureBoardRows(state, requestId) {
  return state.listReceipts()
    .map(row => ({ kind: row.kind, detail: row.detail }))
    .filter(row => row.kind.startsWith('board-refresh') && JSON.parse(row.detail).requestId === requestId);
}

module.exports = { refusalError, buildHarness, directSnapshot, boardSnapshot, fetchEventIndex, assertBracketed, boardRun, boardFixtureBoardRows };
