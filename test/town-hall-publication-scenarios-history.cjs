'use strict';


function foreignAttemptId() {
  return '00000000-0000-4000-8000-0000000000ff';
}

function dropExpressionIndexes(state) {
  const indexes = state.db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='receipts' AND sql LIKE '%json_extract%'"
  ).all();
  for (const index of indexes) state.db.exec(`DROP INDEX ${index.name}`);
  return indexes;
}

function restoreExpressionIndexes(state, indexes) {
  for (const index of indexes) state.db.exec(index.sql);
}

function insertRawReceipt(state, kind, detail, discordId = null) {
  state.db.prepare('INSERT INTO receipts(discord_id, kind, detail, created_at) VALUES(?, ?, ?, ?)')
    .run(discordId, kind, typeof detail === 'string' ? detail : JSON.stringify(detail), '2026-01-01T00:00:00.000Z');
}

module.exports = { foreignAttemptId, dropExpressionIndexes, restoreExpressionIndexes, insertRawReceipt };
