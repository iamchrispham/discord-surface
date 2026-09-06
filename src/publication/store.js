const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const POST_KIND = Object.freeze({ BOARD: 'board', CONTEXT: 'context' });
const CONTEXT_STATUS = Object.freeze({ QUEUED: 'queued', RUNNING: 'running', READY: 'ready', QUIET: 'quiet', UNAVAILABLE: 'unavailable' });
const STATUS = Object.freeze({ PENDING: 'pending', SENDING: 'sending', SENT: 'sent', UNKNOWN: 'unknown', SUPERSEDED: 'superseded' });
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function ownerKey(binding) {
  return hash(['publication-v1', ...['channelId', 'guildId', 'provider', 'nativeId', 'conductorId', 'repoKey', 'generation'].map(key => binding[key])]);
}

const TABLES = {
  publication_heads: `CREATE TABLE publication_heads (
    owner_key TEXT PRIMARY KEY, binding TEXT NOT NULL, processed_id TEXT NOT NULL,
    snapshot TEXT NOT NULL, sequence INTEGER NOT NULL,
    successful_at INTEGER, retry_at INTEGER NOT NULL DEFAULT 0
  )`,
  publication_posts: `CREATE TABLE publication_posts (
    id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, channel_id TEXT NOT NULL, guild_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL, content TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'board' CHECK(kind IN ('board','context')), board_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','unknown','superseded')),
    message_id TEXT UNIQUE, attempted_at INTEGER, sent_at INTEGER, error TEXT
  )`,
  publication_context: `CREATE TABLE publication_context (
    owner_key TEXT NOT NULL, sequence INTEGER NOT NULL, snapshot_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','ready','quiet','unavailable')),
    started_at INTEGER, finished_at INTEGER, reason TEXT,
    PRIMARY KEY(owner_key,sequence)
  )`
};
function createPublicationSchema(db) {
  const version = db.prepare("SELECT value FROM meta WHERE key='publication-schema'").get();
  if (version && version.value !== '1') throw new Error('unsupported publication schema');
  if (!version) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const ddl of Object.values(TABLES)) db.exec(ddl);
      db.exec(`CREATE INDEX publication_owner ON publication_posts(owner_key, status);
        INSERT INTO meta(key, value) VALUES('publication-schema', '1'); COMMIT;`);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const normalize = sql => String(sql).replace(/\s+/g, '').toLowerCase();
  for (const [name, ddl] of Object.entries(TABLES)) {
    const actual = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (normalize(actual?.sql) !== normalize(ddl)) throw new Error(`publication schema mismatch: ${name}`);
  }
}

function policyKey(binding, operatorId) {
  return 'publication:' + hash([operatorId, binding.guildId, binding.provider, binding.conductorId, binding.repoKey]);
}

class PublicationStore extends EventEmitter {
  constructor(state) { super(); this.state = state; this.db = state.db; }
  enabled(binding) {
    const config = this.state.getConfig();
    return Boolean(binding.conductorId && binding.repoKey) && binding.guildId === config.guildId &&
      this.db.prepare('SELECT value FROM config WHERE key=?').get(policyKey(binding, config.operatorId))?.value === 'true';
  }
  contextEnabled(binding) {
    return this.enabled(binding) && this.db.prepare('SELECT value FROM config WHERE key=?')
      .get(policyKey(binding, this.state.getConfig().operatorId) + ':context')?.value === 'true';
  }
  canPublish(binding, post) {
    return this.enabled(binding) && (post.kind !== POST_KIND.CONTEXT || this.contextEnabled(binding));
  }
  setEnabled(binding, enabled, { context = false } = {}) {
    if (typeof enabled !== 'boolean' || typeof context !== 'boolean' || !binding?.conductorId || !binding?.repoKey) throw new Error('publication requires a conductor binding and boolean policy');
    return this.state.transaction(() => {
      if (!this.current(binding)) throw new Error('publication policy binding is stale');
      const key = policyKey(binding, this.state.requireConfig().operatorId);
      const contextEnabled = enabled && context;
      this.db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key, String(enabled));
      this.db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(key + ':context', String(contextEnabled));
      this.state.receipt(null, 'publication-policy', { channelId: binding.channelId, provider: binding.provider,
        conductorId: binding.conductorId, repoKey: binding.repoKey, enabled, contextEnabled });
      return { channelId: binding.channelId, enabled, contextEnabled };
    });
  }
  head(binding) { return this.db.prepare('SELECT * FROM publication_heads WHERE owner_key=?').get(ownerKey(binding)); }
  current(binding) {
    const current = this.state.getBinding(binding.channelId);
    return current?.active && current.guildId === this.state.getConfig().guildId && ownerKey(current) === ownerKey(binding);
  }
  stage(binding, snapshot, content) {
    if (!snapshot?.id || JSON.stringify(snapshot).length > 100000 || typeof content !== 'string' || !content.trim() || content.length > 2000) {
      throw new Error('invalid publication snapshot or content');
    }
    return this.state.transaction(() => {
      if (!this.current(binding) || !this.enabled(binding)) return false;
      const key = ownerKey(binding);
      const old = this.head(binding);
      if (old?.processed_id === snapshot.id) return false;
      this.db.prepare(`INSERT INTO publication_heads(owner_key, binding, processed_id, snapshot, sequence) VALUES(?,?,?,?,?)
        ON CONFLICT(owner_key) DO UPDATE SET processed_id=excluded.processed_id, snapshot=excluded.snapshot, sequence=excluded.sequence`)
        .run(key, JSON.stringify(binding), snapshot.id, JSON.stringify(snapshot), (old?.sequence || 0) + 1);
      this.db.prepare('UPDATE publication_posts SET status=? WHERE owner_key=? AND status=?')
        .run(STATUS.SUPERSEDED, key, STATUS.PENDING);
      const id = hash([key, snapshot.id, (old?.sequence || 0) + 1]);
      this.db.prepare(`INSERT OR IGNORE INTO publication_posts(id,owner_key,channel_id,guild_id,snapshot_id,content,nonce,status)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, key, binding.channelId, binding.guildId, snapshot.id, content, `sp-${id.slice(0, 22)}`, STATUS.PENDING);
      return true;
    });
  }
  pending(binding) {
    const key = ownerKey(binding);
    const blocked = this.db.prepare('SELECT kind,status FROM publication_posts WHERE owner_key=? AND status IN (?,?)')
      .all(key, STATUS.SENDING, STATUS.UNKNOWN);
    if (blocked.some(post => post.kind === POST_KIND.BOARD || post.status === STATUS.SENDING)) return null;
    const board = this.db.prepare('SELECT * FROM publication_posts WHERE owner_key=? AND status=? AND kind=? ORDER BY rowid LIMIT 1')
      .get(key, STATUS.PENDING, POST_KIND.BOARD);
    if (board) return board;
    if (blocked.length || !this.contextEnabled(binding)) return null;
    return this.db.prepare(`SELECT p.* FROM publication_posts p JOIN publication_posts b ON b.id=p.board_id
      WHERE p.owner_key=? AND p.status=? AND p.kind=? AND b.status=? ORDER BY p.rowid LIMIT 1`)
      .get(key, STATUS.PENDING, POST_KIND.CONTEXT, STATUS.SENT);
  }
  begin(binding, id, now) {
    return this.state.transaction(() => {
      if (!this.current(binding) || !this.enabled(binding) || this.state.getBinding(binding.channelId).readiness !== 'ready') return false;
      if (this.pending(binding)?.id !== id) return false;
      return Boolean(this.db.prepare('UPDATE publication_posts SET status=?, attempted_at=?, error=NULL WHERE id=? AND status=?')
        .run(STATUS.SENDING, now, id, STATUS.PENDING).changes);
    });
  }
  sent(id, messageId, now) {
    if (typeof messageId !== 'string' || !messageId) throw new Error('publication response lacks message id');
    return this.state.transaction(() => {
      const post = this.db.prepare('SELECT * FROM publication_posts WHERE id=?').get(id);
      if (!post || post.status === STATUS.SENT) return;
      this.db.prepare('UPDATE publication_posts SET status=?, message_id=?, sent_at=?, error=NULL WHERE id=?')
        .run(STATUS.SENT, messageId, now, id);
      this.db.prepare('UPDATE publication_heads SET successful_at=?, retry_at=0 WHERE owner_key=?').run(now, post.owner_key);
    });
  }
  failed(id, error, now, retryMs) {
    const definite = error?.outcome === 'not_sent';
    this.state.transaction(() => {
      // A Gateway echo may have already established that the request succeeded.
      const post = this.db.prepare('SELECT * FROM publication_posts WHERE id=?').get(id);
      if (!post || post.status === STATUS.SENT) return;
      const latest = this.db.prepare('SELECT processed_id FROM publication_heads WHERE owner_key=?').get(post.owner_key);
      const status = definite ? (latest?.processed_id === post.snapshot_id ? STATUS.PENDING : STATUS.SUPERSEDED) : STATUS.UNKNOWN;
      this.db.prepare('UPDATE publication_posts SET status=?, error=? WHERE id=?')
        .run(status, String(error?.message || error).slice(0, 300), id);
      if (definite) this.db.prepare('UPDATE publication_heads SET retry_at=? WHERE owner_key=?').run(now + retryMs, post.owner_key);
    });
  }
  queueContext(binding, snapshot) {
    const head = this.head(binding);
    if (!head || !this.current(binding) || !this.contextEnabled(binding)) return;
    this.db.prepare('INSERT OR IGNORE INTO publication_context(owner_key,sequence,snapshot_id,status) VALUES(?,?,?,?)')
      .run(ownerKey(binding), head.sequence, snapshot.id, CONTEXT_STATUS.QUEUED);
  }
  contextWork() {
    return this.db.prepare('SELECT * FROM publication_context WHERE status=? ORDER BY rowid').all(CONTEXT_STATUS.QUEUED);
  }
  finishContext(work, result, now) {
    return this.state.transaction(() => {
      const head = this.db.prepare('SELECT * FROM publication_heads WHERE owner_key=?').get(work.owner_key);
      const binding = head && JSON.parse(head.binding);
      const current = head?.sequence === work.sequence && head.processed_id === work.snapshot_id && this.current(binding) && this.contextEnabled(binding);
      const useful = current && result?.status === 'ready' && result.snapshotId === work.snapshot_id &&
        typeof result.preview === 'string' && result.preview.trim() && result.preview.length <= 2000;
      let outcome = CONTEXT_STATUS.UNAVAILABLE;
      if (useful) {
        const board = this.db.prepare('SELECT id FROM publication_posts WHERE owner_key=? AND snapshot_id=? AND kind=? ORDER BY rowid DESC LIMIT 1')
          .get(work.owner_key, work.snapshot_id, POST_KIND.BOARD);
        const id = hash(['context', work.owner_key, work.sequence]);
        this.db.prepare(`INSERT OR IGNORE INTO publication_posts(id,owner_key,channel_id,guild_id,snapshot_id,content,nonce,kind,board_id,status)
          VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, work.owner_key, binding.channelId, binding.guildId, work.snapshot_id,
            result.preview, 'sp-' + id.slice(0, 22), POST_KIND.CONTEXT, board.id, STATUS.PENDING);
        outcome = CONTEXT_STATUS.READY;
      } else if (current && result?.status === 'ready' && result.interpretation?.decision === 'quiet') outcome = CONTEXT_STATUS.QUIET;
      this.db.prepare('UPDATE publication_context SET status=?,finished_at=?,reason=? WHERE owner_key=? AND sequence=?')
        .run(outcome, now, current ? result?.reason || null : 'superseded', work.owner_key, work.sequence);
      return outcome;
    });
  }
  status() {
    const bindings = this.state.listBindings().filter(binding => binding.active && binding.conductorId);
    const keys = new Set(bindings.map(ownerKey));
    const unresolved = this.db.prepare(`SELECT h.binding,h.owner_key FROM publication_heads h WHERE EXISTS
      (SELECT 1 FROM publication_posts p WHERE p.owner_key=h.owner_key AND p.status IN (?,?))`).all(STATUS.SENDING, STATUS.UNKNOWN);
    for (const row of unresolved) if (!keys.has(row.owner_key)) bindings.push(JSON.parse(row.binding));
    return bindings.map(binding => {
      const head = this.head(binding);
      const posts = this.db.prepare('SELECT status,COUNT(*) AS count FROM publication_posts WHERE owner_key=? GROUP BY status').all(ownerKey(binding));
      return { channelId: binding.channelId, nativeId: binding.nativeId, generation: binding.generation,
        current: Boolean(this.current(binding)), enabled: this.enabled(binding), contextEnabled: this.contextEnabled(binding),
        processedSnapshotId: head?.processed_id || null, successfulAt: head?.successful_at ?? null,
        retryAt: head?.retry_at || null, counts: Object.fromEntries(posts.map(row => [row.status, Number(row.count)])) };
    });
  }
  recover() {
    this.db.prepare('UPDATE publication_posts SET status=?, error=? WHERE status=?')
      .run(STATUS.UNKNOWN, 'process stopped during publication; readback required', STATUS.SENDING);
  }
  findEvent(event) {
    return this.db.prepare(`SELECT * FROM publication_posts WHERE channel_id=? AND guild_id=?
      AND (message_id=? OR (nonce=? AND status IN (?,?,?))) LIMIT 1`)
      .get(event.channelId, event.guildId, event.id, event.isBot && typeof event.nonce === 'string' ? event.nonce : '', STATUS.SENDING, STATUS.UNKNOWN, STATUS.SENT);
  }
  excludeEvent(event) {
    const post = this.findEvent(event);
    if (!post) return false;
    // Only a Discord bot echo can settle uncertain transport custody. An ID match
    // still excludes a replay whose normalization lost the bot flag.
    if (event.isBot && post.status !== STATUS.SENT) {
      this.sent(post.id, event.id, Date.now());
      this.emit('settled');
    }
    return true;
  }
}

module.exports = { STATUS, POST_KIND, CONTEXT_STATUS, ownerKey, createPublicationSchema, PublicationStore };
