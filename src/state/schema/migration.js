function createSchemaMigration({ SCHEMA_VERSION, StateCorruptError, parseJson, compareDiscordIds, READINESS, now }) {
  return {
    migrateSchema() {
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get();
    if (!version) throw new StateCorruptError('state schema metadata is missing');
    if (version.value !== '1.1' && version.value !== '1.2' && version.value !== '1.3' && version.value !== '1.4' && version.value !== '1.5' && version.value !== '1.6' && version.value !== '1.7' && version.value !== SCHEMA_VERSION) {
      throw new StateCorruptError(`unsupported state schema ${version.value}`);
    }
    if (version.value === SCHEMA_VERSION) {
      const bindings = this.tableColumns('bindings');
      if (!bindings.has('session_root')) this.db.exec('ALTER TABLE bindings ADD COLUMN session_root TEXT');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS topic_publications (
          request_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
          native_id TEXT NOT NULL,
          conductor_id TEXT,
          repo_key TEXT,
          generation INTEGER NOT NULL CHECK(generation > 0),
          desired_readiness TEXT NOT NULL CHECK(desired_readiness IN ('pending', 'ready', 'unavailable', 'recovering', 'gap')),
          desired_topic TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('in_flight', 'unknown', 'published', 'not_published')),
          outcome TEXT,
          evidence_scope TEXT,
          error TEXT,
          operation_ended_at TEXT,
          readback_at TEXT,
          readback_topic TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS topic_publications_channel_idx ON topic_publications(channel_id, updated_at);
        CREATE INDEX IF NOT EXISTS topic_publications_unresolved_idx ON topic_publications(channel_id) WHERE status IN ('in_flight', 'unknown');
      `);
      const topicColumns = this.tableColumns('topic_publications');
      if (!topicColumns.has('operation_ended_at')) this.db.exec('ALTER TABLE topic_publications ADD COLUMN operation_ended_at TEXT');
      if (!topicColumns.has('readback_at')) this.db.exec('ALTER TABLE topic_publications ADD COLUMN readback_at TEXT');
      if (!topicColumns.has('readback_topic')) this.db.exec('ALTER TABLE topic_publications ADD COLUMN readback_topic TEXT');
      this.ensureThreadEnrollmentSchema();
      this.ensureNativeReplyFileSchema();
      this.ensureDirectPostIndexes();
      return;
    }
    if (version.value === '1.7') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.ensureNativeReplyFileSchema();
        this.db.prepare("UPDATE meta SET value=? WHERE key='schema'").run(SCHEMA_VERSION);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      this.ensureDirectPostIndexes();
      return;
    }
    if (version.value === '1.6') {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.ensureThreadEnrollmentSchema();
        this.ensureNativeReplyFileSchema();
        this.db.prepare("UPDATE meta SET value=? WHERE key='schema'").run(SCHEMA_VERSION);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      this.ensureDirectPostIndexes();
      return;
    }
    if (version.value === '1.1') {
      const bindings = this.tableColumns('bindings');
      const messages = this.tableColumns('messages');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!bindings.has('category_id')) this.db.exec('ALTER TABLE bindings ADD COLUMN category_id TEXT');
        if (!bindings.has('active')) this.db.exec('ALTER TABLE bindings ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
        if (!messages.has('reply_next_part')) this.db.exec('ALTER TABLE messages ADD COLUMN reply_next_part INTEGER NOT NULL DEFAULT 0');
        if (!messages.has('observer_cursor')) this.db.exec('ALTER TABLE messages ADD COLUMN observer_cursor TEXT');
        if (!messages.has('observer_marker')) this.db.exec('ALTER TABLE messages ADD COLUMN observer_marker TEXT');
        this.db.exec(`
          DROP INDEX IF EXISTS bindings_native_id_unique;
          CREATE UNIQUE INDEX IF NOT EXISTS bindings_native_id_unique ON bindings(provider, native_id) WHERE active=1;
          CREATE TABLE IF NOT EXISTS reply_parts (
            discord_id TEXT NOT NULL REFERENCES messages(discord_id),
            part_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            nonce TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
            message_id TEXT,
            error TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(discord_id, part_index)
          );
          CREATE TABLE IF NOT EXISTS provision_intents (
            provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
            native_id TEXT NOT NULL,
            guild_id TEXT NOT NULL,
            category_id TEXT NOT NULL,
            workspace TEXT NOT NULL,
            endpoint TEXT,
            marker TEXT NOT NULL,
            task_name TEXT,
            channel_id TEXT,
            state TEXT NOT NULL CHECK(state IN ('pending', 'resolved')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(provider, native_id)
          );
          UPDATE meta SET value='1.2' WHERE key='schema';
        `);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }
    const bindings = this.tableColumns('bindings');
    const messages = this.tableColumns('messages');
    const intents = this.tableColumns('provision_intents');
    const watermarks = this.tableColumns('intake_watermarks');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!bindings.has('conductor_id')) this.db.exec('ALTER TABLE bindings ADD COLUMN conductor_id TEXT');
      if (!bindings.has('repo_key')) this.db.exec('ALTER TABLE bindings ADD COLUMN repo_key TEXT');
      if (!bindings.has('readiness')) this.db.exec("ALTER TABLE bindings ADD COLUMN readiness TEXT NOT NULL DEFAULT 'pending'");
      if (!bindings.has('session_root')) this.db.exec('ALTER TABLE bindings ADD COLUMN session_root TEXT');
      if (!messages.has('conductor_id')) this.db.exec('ALTER TABLE messages ADD COLUMN conductor_id TEXT');
      if (!messages.has('repo_key')) this.db.exec('ALTER TABLE messages ADD COLUMN repo_key TEXT');
      if (!messages.has('attachments')) this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
      if (!intents.has('conductor_id')) this.db.exec('ALTER TABLE provision_intents ADD COLUMN conductor_id TEXT');
      if (!intents.has('repo_key')) this.db.exec('ALTER TABLE provision_intents ADD COLUMN repo_key TEXT');
      if (watermarks.size && !watermarks.has('recovered_through_id')) {
        this.db.exec('ALTER TABLE intake_watermarks ADD COLUMN recovered_through_id TEXT');
        const baselineByChannel = new Map();
        for (const row of this.db.prepare("SELECT detail FROM receipts WHERE kind='intake-baseline' ORDER BY id").all()) {
          const detail = parseJson(row.detail, {});
          if (typeof detail.channelId === 'string' && typeof detail.lastSeenId === 'string') baselineByChannel.set(detail.channelId, detail.lastSeenId);
        }
        for (const row of this.db.prepare('SELECT * FROM intake_watermarks').all()) {
          const baselineId = baselineByChannel.get(row.channel_id);
          const confirmed = baselineId && row.last_seen_id && compareDiscordIds(baselineId, row.last_seen_id) <= 0 ? baselineId : null;
          const nextState = confirmed
            ? (row.state === 'gap' || row.state === 'unavailable' ? row.state : 'pending')
            : 'gap';
          const detail = confirmed
            ? 'schema migration retained the recorded intake baseline; recovery is required'
            : 'schema migration found an unverified legacy intake cursor; explicit reconciliation is required';
          this.db.prepare('UPDATE intake_watermarks SET recovered_through_id=?, state=?, detail=?, gap_to=? WHERE channel_id=?')
            .run(confirmed, nextState, detail, confirmed ? row.gap_to : row.last_seen_id, row.channel_id);
          this.db.prepare('UPDATE bindings SET readiness=?, updated_at=? WHERE channel_id=? AND active=1')
            .run(nextState === 'unavailable' ? READINESS.UNAVAILABLE : nextState === 'gap' ? READINESS.GAP : READINESS.PENDING, now(), row.channel_id);
          this.receipt(null, 'legacy-intake-migration', { channelId: row.channel_id, recoveredThroughId: confirmed, state: nextState });
        }
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS bindings_conductor_unique ON bindings(provider, conductor_id) WHERE active=1 AND conductor_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS provision_conductor_unique ON provision_intents(provider, conductor_id) WHERE conductor_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS intake_watermarks (
          channel_id TEXT PRIMARY KEY,
          guild_id TEXT NOT NULL,
          last_seen_id TEXT,
          recovered_through_id TEXT,
          last_accepted_id TEXT,
          state TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'gap', 'unavailable')),
          gap_from TEXT,
          gap_to TEXT,
          detail TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS topic_publications (
          request_id TEXT PRIMARY KEY,
          channel_id TEXT NOT NULL,
          guild_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
          native_id TEXT NOT NULL,
          conductor_id TEXT,
          repo_key TEXT,
          generation INTEGER NOT NULL CHECK(generation > 0),
          desired_readiness TEXT NOT NULL CHECK(desired_readiness IN ('pending', 'ready', 'unavailable', 'recovering', 'gap')),
          desired_topic TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('in_flight', 'unknown', 'published', 'not_published')),
          outcome TEXT,
          evidence_scope TEXT,
          error TEXT,
          operation_ended_at TEXT,
          readback_at TEXT,
          readback_topic TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS topic_publications_channel_idx ON topic_publications(channel_id, updated_at);
        CREATE INDEX IF NOT EXISTS topic_publications_unresolved_idx ON topic_publications(channel_id) WHERE status IN ('in_flight', 'unknown');
        UPDATE meta SET value='${SCHEMA_VERSION}' WHERE key='schema';
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    this.ensureThreadEnrollmentSchema();
    this.ensureNativeReplyFileSchema();
    this.ensureDirectPostIndexes();
  }
  };
}

module.exports = { createSchemaMigration };
