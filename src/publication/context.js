const { interpretSnapshot, contextPacket } = require('../context-interpretation');
const { CONTEXT_STATUS } = require('./store');

const CONTEXT_DISABLED = Symbol('context-disabled');

function contextualPublications({ store, interpret = interpretSnapshot, schedule, clock = Date.now }) {
  let closed = false;
  let active = null;
  store.db.prepare('UPDATE publication_context SET status=?,reason=?,finished_at=? WHERE status=?')
    .run(CONTEXT_STATUS.UNAVAILABLE, 'interrupted', clock(), CONTEXT_STATUS.RUNNING);

  function sourceFor(work) {
    const head = store.db.prepare('SELECT * FROM publication_heads WHERE owner_key=?').get(work.owner_key);
    if (!head || head.sequence !== work.sequence || head.processed_id !== work.snapshot_id) return null;
    const binding = JSON.parse(head.binding);
    if (!store.current(binding)) return null;
    if (!store.contextEnabled(binding)) return CONTEXT_DISABLED;
    const snapshot = JSON.parse(head.snapshot);
    if (snapshot.expiresAt && snapshot.expiresAt * 1000 <= clock()) return null;
    if (snapshot.context?.freshness !== 'current') return null;
    const history = store.sentHistory(binding);
    return contextPacket(snapshot, history) ? { snapshot, history } : null;
  }
  function pump() {
    if (closed) return;
    if (active) {
      const source = sourceFor(active.work);
      if (!source || source === CONTEXT_DISABLED) active.controller.abort();
      return;
    }
    for (const work of store.contextWork()) {
      const source = sourceFor(work);
      if (source === CONTEXT_DISABLED) continue;
      if (!source) { store.finishContext(work, { reason: 'source-unavailable' }, clock()); continue; }
      const claimed = store.db.prepare('UPDATE publication_context SET status=?,started_at=? WHERE owner_key=? AND sequence=? AND status=?')
        .run(CONTEXT_STATUS.RUNNING, clock(), work.owner_key, work.sequence, CONTEXT_STATUS.QUEUED).changes;
      if (!claimed) continue;
      const controller = new AbortController();
      const task = { work, controller, promise: null };
      active = task;
      task.promise = Promise.resolve().then(() => interpret(source.snapshot, { signal: controller.signal, history: source.history }))
        .catch(() => ({ status: 'unavailable', reason: 'interpretation-failed' }))
        .then(result => {
          store.finishContext(work, closed || controller.signal.aborted ? { reason: 'cancelled' } : result, clock());
          if (!closed) schedule();
        }).finally(() => { active = null; if (!closed) pump(); });
      return;
    }
  }
  return {
    observe(binding, snapshot) { if (!closed && contextPacket(snapshot)) store.queueContext(binding, snapshot); },
    pump,
    async stop() { closed = true; active?.controller.abort(); await active?.promise; }
  };
}

module.exports = { contextualPublications };
