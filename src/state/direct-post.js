function queryDirectPostRows({ db, assertText, parseJson, StateCorruptError, attemptKind, outcomeKind }, requestId = null, channelId = null) {
  if (requestId !== null) assertText(requestId, 'requestId', 256);
  if (channelId !== null) assertText(channelId, 'channelId', 128);
  const clauses = ['discord_id IS NULL', 'kind IN (?, ?)'];
  const params = [attemptKind, outcomeKind];
  if (requestId !== null) {
    clauses.push("json_extract(detail, '$.requestId')=?");
    params.push(requestId);
  }
  if (channelId !== null) {
    clauses.push("json_extract(detail, '$.channelId')=?");
    params.push(channelId);
  }
  const rows = db.prepare(`SELECT id, kind, detail, created_at FROM receipts
    WHERE ${clauses.join(' AND ')} ORDER BY id`).all(...params);
  return rows.map(row => {
    const detail = parseJson(row.detail, null);
    if (!detail || detail.journal !== 'direct-post-v1') throw new StateCorruptError('direct post receipt is malformed');
    if (detail.inReplyTo === undefined) detail.inReplyTo = null;
    return { id: Number(row.id), kind: row.kind, detail, createdAt: row.created_at };
  });
}

module.exports = { queryDirectPostRows };
