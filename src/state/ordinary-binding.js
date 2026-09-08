function hasOrdinaryBindingReceipt({ db }, binding) {
  return Boolean(db.prepare(`SELECT 1 FROM receipts
    WHERE kind='ordinary-bound'
      AND json_extract(detail, '$.channelId')=?
      AND json_extract(detail, '$.nativeId')=?
      AND json_extract(detail, '$.workspace')=?
      AND json_extract(detail, '$.generation')=?
    LIMIT 1`).get(binding.channelId, binding.nativeId, binding.workspace, binding.generation));
}

function hasOrdinaryPreflightReceipt({ db }, binding) {
  return Boolean(db.prepare(`SELECT 1 FROM receipts
    WHERE kind='ordinary-native-preflight'
      AND json_extract(detail, '$.channelId')=?
      AND json_extract(detail, '$.nativeId')=?
      AND json_extract(detail, '$.workspace')=?
      AND json_extract(detail, '$.generation')=?
      AND json_extract(detail, '$.sessionRoot') IS ?
      AND json_extract(detail, '$.outcome')='verified'
    LIMIT 1`).get(binding.channelId, binding.nativeId, binding.workspace, binding.generation, binding.sessionRoot || null));
}

module.exports = { hasOrdinaryBindingReceipt, hasOrdinaryPreflightReceipt };
