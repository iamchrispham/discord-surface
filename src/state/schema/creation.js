function createSchemaCreation({ SCHEMA_VERSION }) {
  return {
    createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '${SCHEMA_VERSION}');
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bindings (
        channel_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
        native_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        session_root TEXT,
        endpoint TEXT,
        category_id TEXT,
        conductor_id TEXT,
        repo_key TEXT,
        readiness TEXT NOT NULL DEFAULT 'pending' CHECK(readiness IN ('pending', 'ready', 'unavailable', 'recovering', 'gap')),
        generation INTEGER NOT NULL CHECK(generation > 0),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_native_id_unique ON bindings(provider, native_id) WHERE active=1;
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_conductor_unique ON bindings(provider, conductor_id) WHERE active=1 AND conductor_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS messages (
        discord_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES bindings(channel_id),
        delivery_channel_id TEXT,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT NOT NULL DEFAULT '[]',
        provider TEXT NOT NULL,
        native_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        endpoint TEXT,
        conductor_id TEXT,
        repo_key TEXT,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        reply_text TEXT,
        reply_nonce TEXT UNIQUE,
        reply_message_id TEXT,
        reply_next_part INTEGER NOT NULL DEFAULT 0,
        observer_cursor TEXT,
        observer_marker TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_state_idx ON messages(state);
      CREATE TABLE IF NOT EXISTS thread_enrollments (
        thread_id TEXT PRIMARY KEY,
        parent_channel_id TEXT NOT NULL REFERENCES bindings(channel_id),
        guild_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'gap', 'unavailable')),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        adopted_through_id TEXT,
        adopted_at TEXT,
        last_seen_id TEXT,
        recovered_through_id TEXT,
        last_accepted_id TEXT,
        gap_from TEXT,
        gap_to TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_enrollments_parent_idx ON thread_enrollments(parent_channel_id, active);
      CREATE TABLE IF NOT EXISTS reply_parts (
        discord_id TEXT NOT NULL REFERENCES messages(discord_id),
        part_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
        message_id TEXT,
        error TEXT,
        file_manifest TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(discord_id, part_index)
      );
      CREATE TABLE IF NOT EXISTS provision_intents (
        provider TEXT NOT NULL CHECK(provider IN ('codex', 'claude')),
        native_id TEXT NOT NULL,
        conductor_id TEXT,
        repo_key TEXT,
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
      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_id TEXT REFERENCES messages(discord_id),
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
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
    `);
    this.ensureThreadEnrollmentSchema();
    this.ensureNativeReplyFileSchema();
    this.ensureDirectPostIndexes();
  },

    tableColumns(table) {
    return new Map(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => [row.name, row]));
  },

    ensureThreadEnrollmentSchema() {
    const messages = this.tableColumns('messages');
    if (!messages.has('delivery_channel_id')) this.db.exec('ALTER TABLE messages ADD COLUMN delivery_channel_id TEXT');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_enrollments (
        thread_id TEXT PRIMARY KEY,
        parent_channel_id TEXT NOT NULL REFERENCES bindings(channel_id),
        guild_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'ready', 'gap', 'unavailable')),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        adopted_through_id TEXT,
        adopted_at TEXT,
        last_seen_id TEXT,
        recovered_through_id TEXT,
        last_accepted_id TEXT,
        gap_from TEXT,
        gap_to TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_enrollments_parent_idx ON thread_enrollments(parent_channel_id, active);
    `);
    this.db.prepare('UPDATE messages SET delivery_channel_id=channel_id WHERE delivery_channel_id IS NULL').run();
  },

    ensureNativeReplyFileSchema() {
    const columns = this.tableColumns('reply_parts');
    if (!columns.has('file_manifest')) this.db.exec('ALTER TABLE reply_parts ADD COLUMN file_manifest TEXT');
  },

    ensureDirectPostIndexes() {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS direct_post_outcome_message_idx
        ON receipts(json_extract(detail, '$.messageId')) WHERE kind='direct-post-outcome';
      CREATE INDEX IF NOT EXISTS direct_post_outcome_nonce_idx
        ON receipts(json_extract(detail, '$.nonce')) WHERE kind='direct-post-outcome';
      CREATE INDEX IF NOT EXISTS acknowledgment_receipt_idx
        ON receipts(kind, discord_id, id);
      CREATE INDEX IF NOT EXISTS receipts_channel_kind_idx
        ON receipts(json_extract(detail, '$.channelId'), kind);
      CREATE INDEX IF NOT EXISTS ordinary_bound_identity_idx
        ON receipts(
          json_extract(detail, '$.channelId'),
          json_extract(detail, '$.nativeId'),
          json_extract(detail, '$.workspace'),
          json_extract(detail, '$.generation')
        ) WHERE kind='ordinary-bound';
      CREATE INDEX IF NOT EXISTS ordinary_preflight_identity_idx
        ON receipts(
          json_extract(detail, '$.channelId'),
          json_extract(detail, '$.nativeId'),
          json_extract(detail, '$.workspace'),
          json_extract(detail, '$.generation'),
          json_extract(detail, '$.sessionRoot'),
          json_extract(detail, '$.outcome')
        ) WHERE kind='ordinary-native-preflight';
    `);
  }
  };
}

module.exports = { createSchemaCreation };
