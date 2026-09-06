const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readSnapshot, renderSnapshot } = require('../snapshot');
const { ownerKey } = require('./store');
const { contextualPublications } = require('./context');

const CADENCE = Object.freeze({ burstMs: 500, publicationMs: 60000, retryMs: 60000 });

function watchPublications({ state, send, ready = () => true, logger = () => {},
  registry = path.join(os.homedir(), '.agents/work-control/pr-lanes.json'),
  read = readSnapshot, interpret, cadence = CADENCE, clock = Date.now, watchFactory = fs.watch, rearmMs = 1000 } = {}) {
  const store = state.publications;
  const controller = new AbortController();
  let closed = false;
  let running = null;
  let dirty = false;
  let burst = null;
  let wake = null;
  let bindingSignature = '';
  const watchers = [];
  store.recover();
  const context = contextualPublications({ store, interpret, schedule, clock });

  function bindings() {
    return state.listBindings().filter(binding => binding.active && binding.conductorId && binding.repoKey && store.enabled(binding));
  }
  function schedule() {
    if (closed || burst) return;
    burst = setTimeout(() => { burst = null; drain(); }, cadence.burstMs);
  }
  async function drain() {
    if (closed) return;
    if (running) { dirty = true; return running; }
    clearTimeout(wake);
    wake = null;
    running = (async () => {
      let nextWake = Infinity;
      for (const binding of bindings()) {
        if (closed) break;
        let snapshot = await read(binding, { registry, now: clock() / 1000, signal: controller.signal });
        if (closed || !store.current(binding)) continue;
        if (snapshot.unavailable) {
          logger(`publication source unavailable for ${binding.channelId}: ${snapshot.unavailable}`);
          if (!store.head(binding)) continue;
          snapshot = { id: crypto.createHash('sha256').update(ownerKey(binding) + ':unavailable').digest('hex'), unavailable: true };
        }
        if (!snapshot.unavailable && snapshot.context.state !== 'recorded' && !store.head(binding)) continue;
        store.stage(binding, snapshot, renderSnapshot(snapshot));
        context.observe(binding, snapshot);
        if (snapshot.expiresAt * 1000 > clock()) nextWake = Math.min(nextWake, snapshot.expiresAt * 1000);
        const post = store.pending(binding);
        if (!post) continue;
        const head = store.head(binding);
        const due = Math.max(head.successful_at === null ? 0 : head.successful_at + cadence.publicationMs, head.retry_at);
        if (due > clock()) { nextWake = Math.min(nextWake, due); continue; }
        if (!ready() || binding.readiness !== 'ready') continue;
        if (!store.begin(binding, post.id, clock())) continue;
        try {
          const response = await send(binding, post, controller.signal);
          store.sent(post.id, response?.id, clock());
          if (store.pending(binding)) nextWake = Math.min(nextWake, clock() + cadence.publicationMs);
        } catch (error) {
          store.failed(post.id, error, clock(), cadence.retryMs);
          if (store.pending(binding)) nextWake = Math.min(nextWake, clock() + cadence.retryMs);
          logger(`publication ${post.id.slice(0, 10)}: ${error.message}`);
        }
      }
      context.pump();
      if (!closed && Number.isFinite(nextWake)) {
        wake = setTimeout(() => { wake = null; drain(); }, Math.max(1, nextWake - clock()));
      }
    })().catch(error => logger(`publication drain failed: ${error.message}`));
    try { await running; }
    finally {
      running = null;
      if (dirty) { dirty = false; schedule(); }
    }
  }
  function watch(directory, callback) {
    const entry = { watcher: null, retry: null, delay: rearmMs };
    watchers.push(entry);
    function retry(error) {
      if (closed || entry.retry) return;
      entry.watcher?.close();
      entry.watcher = null;
      logger(`publication watch unavailable: ${error.message}`);
      entry.retry = setTimeout(() => { entry.retry = null; arm(); }, entry.delay);
      entry.delay = Math.min(entry.delay * 2, 60000);
    }
    function arm() {
      if (closed) return;
      try {
        const watcher = watchFactory(directory, (...args) => { entry.delay = rearmMs; callback(...args); });
        entry.watcher = watcher;
        watcher.on('error', error => { if (entry.watcher === watcher) retry(error); });
        schedule();
      } catch (error) { retry(error); }
    }
    arm();
  }
  const registryName = path.basename(registry);
  watch(path.dirname(registry), (_event, name) => {
    if (!name || String(name) === registryName) schedule();
  });
  const dbName = path.basename(state.dbPath);
  function changedBindings() {
    const signature = JSON.stringify(bindings().map(binding => [ownerKey(binding), binding.readiness]).sort());
    if (signature !== bindingSignature) { bindingSignature = signature; schedule(); }
  }
  watch(path.dirname(state.dbPath), (_event, name) => {
    if (!name || String(name).startsWith(dbName)) changedBindings();
  });
  store.on('settled', schedule);
  changedBindings();
  schedule();
  return {
    drain,
    schedule,
    async stop() {
      closed = true;
      store.off('settled', schedule);
      controller.abort();
      for (const entry of watchers) {
        clearTimeout(entry.retry);
        entry.watcher?.close();
      }
      clearTimeout(burst);
      clearTimeout(wake);
      const contextStop = context.stop();
      await running;
      await contextStop;
    }
  };
}

module.exports = { CADENCE, watchPublications };
