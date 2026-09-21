function createSchemaValidation({ SCHEMA_VERSION, StateCorruptError }) {
  return {
    assertColumns(table, required) {
    const columns = this.tableColumns(table);
    for (const [name, rule] of Object.entries(required)) {
      const row = columns.get(name);
      if (!row) throw new StateCorruptError(`state table ${table} is missing column ${name}`);
      if (rule.type && String(row.type).toUpperCase() !== rule.type) throw new StateCorruptError(`state table ${table}.${name} has wrong type`);
      if (rule.notnull && row.notnull !== 1) throw new StateCorruptError(`state table ${table}.${name} must be NOT NULL`);
    }
  },

    assertForeignKey(table, from, target, to) {
    const found = this.db.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .some(row => row.from === from && row.table === target && row.to === to);
    if (!found) throw new StateCorruptError(`state foreign key ${table}.${from} -> ${target}.${to} is missing`);
  },

    assertSchema() {
    const expected = ['meta', 'config', 'bindings', 'messages', 'reply_parts', 'provision_intents', 'intake_watermarks', 'receipts', 'topic_publications', 'thread_enrollments'];
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const found = new Set(rows.map(row => row.name));
    if (expected.some(name => !found.has(name))) throw new StateCorruptError('state schema is incomplete');
    const version = this.db.prepare("SELECT value FROM meta WHERE key='schema'").get();
    if (!version || version.value !== SCHEMA_VERSION) throw new StateCorruptError('unsupported state schema');
    this.assertColumns('meta', { key: { type: 'TEXT' }, value: { type: 'TEXT', notnull: true } });
    this.assertColumns('config', { key: { type: 'TEXT' }, value: { type: 'TEXT', notnull: true } });
    this.assertColumns('bindings', {
      channel_id: { type: 'TEXT' }, guild_id: { type: 'TEXT', notnull: true },
      provider: { type: 'TEXT', notnull: true }, native_id: { type: 'TEXT', notnull: true },
      workspace: { type: 'TEXT', notnull: true }, session_root: { type: 'TEXT' }, conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' },
      readiness: { type: 'TEXT', notnull: true }, generation: { type: 'INTEGER', notnull: true },
      active: { type: 'INTEGER', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('messages', {
      discord_id: { type: 'TEXT' }, guild_id: { type: 'TEXT', notnull: true },
      channel_id: { type: 'TEXT', notnull: true }, author_id: { type: 'TEXT', notnull: true },
      delivery_channel_id: { type: 'TEXT' },
      content: { type: 'TEXT', notnull: true }, attachments: { type: 'TEXT', notnull: true }, conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' }, state: { type: 'TEXT', notnull: true },
      reply_next_part: { type: 'INTEGER', notnull: true }, created_at: { type: 'TEXT', notnull: true },
      updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('reply_parts', {
      discord_id: { type: 'TEXT', notnull: true }, part_index: { type: 'INTEGER', notnull: true },
      content: { type: 'TEXT', notnull: true }, nonce: { type: 'TEXT', notnull: true },
      state: { type: 'TEXT', notnull: true }, file_manifest: { type: 'TEXT' }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('provision_intents', {
      provider: { type: 'TEXT', notnull: true }, native_id: { type: 'TEXT', notnull: true },
      conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' },
      guild_id: { type: 'TEXT', notnull: true }, category_id: { type: 'TEXT', notnull: true },
      workspace: { type: 'TEXT', notnull: true }, marker: { type: 'TEXT', notnull: true },
      state: { type: 'TEXT', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('intake_watermarks', {
      channel_id: { type: 'TEXT' }, guild_id: { type: 'TEXT', notnull: true },
      recovered_through_id: { type: 'TEXT' },
      state: { type: 'TEXT', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('receipts', {
      id: { type: 'INTEGER', notnull: false }, kind: { type: 'TEXT', notnull: true },
      detail: { type: 'TEXT', notnull: true }, created_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('topic_publications', {
      request_id: { type: 'TEXT', notnull: false }, channel_id: { type: 'TEXT', notnull: true },
      guild_id: { type: 'TEXT', notnull: true }, provider: { type: 'TEXT', notnull: true },
      native_id: { type: 'TEXT', notnull: true }, conductor_id: { type: 'TEXT' }, repo_key: { type: 'TEXT' },
      generation: { type: 'INTEGER', notnull: true }, desired_readiness: { type: 'TEXT', notnull: true },
      desired_topic: { type: 'TEXT', notnull: true }, status: { type: 'TEXT', notnull: true },
      outcome: { type: 'TEXT' }, evidence_scope: { type: 'TEXT' }, error: { type: 'TEXT' },
      operation_ended_at: { type: 'TEXT' }, readback_at: { type: 'TEXT' }, readback_topic: { type: 'TEXT' },
      created_at: { type: 'TEXT', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertColumns('thread_enrollments', {
      thread_id: { type: 'TEXT' }, parent_channel_id: { type: 'TEXT', notnull: true },
      guild_id: { type: 'TEXT', notnull: true }, state: { type: 'TEXT', notnull: true },
      active: { type: 'INTEGER', notnull: true }, adopted_through_id: { type: 'TEXT' },
      adopted_at: { type: 'TEXT' }, last_seen_id: { type: 'TEXT' },
      recovered_through_id: { type: 'TEXT' }, last_accepted_id: { type: 'TEXT' },
      gap_from: { type: 'TEXT' }, gap_to: { type: 'TEXT' }, detail: { type: 'TEXT' },
      created_at: { type: 'TEXT', notnull: true }, updated_at: { type: 'TEXT', notnull: true }
    });
    this.assertForeignKey('messages', 'channel_id', 'bindings', 'channel_id');
    this.assertForeignKey('thread_enrollments', 'parent_channel_id', 'bindings', 'channel_id');
    this.assertForeignKey('reply_parts', 'discord_id', 'messages', 'discord_id');
    this.assertForeignKey('receipts', 'discord_id', 'messages', 'discord_id');
    const integrity = this.db.prepare('PRAGMA integrity_check').all();
    if (integrity.some(row => Object.values(row)[0] !== 'ok')) throw new StateCorruptError('state integrity check failed');
    if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new StateCorruptError('state foreign key check failed');
    const index = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='bindings_native_id_unique'").get();
    if (!index?.sql || !/\(provider\s*,\s*native_id\)/i.test(index.sql) || !/WHERE\s+active\s*=\s*1/i.test(index.sql)) throw new StateCorruptError('native binding uniqueness guard is missing');
    const conductorIndex = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='bindings_conductor_unique'").get();
    if (!conductorIndex?.sql || !/\(provider\s*,\s*conductor_id\)/i.test(conductorIndex.sql)) throw new StateCorruptError('conductor identity uniqueness guard is missing');
    const topicIndex = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='topic_publications_unresolved_idx'").get();
    if (!topicIndex?.sql || !/status\s+IN\s*\('in_flight',\s*'unknown'\)/i.test(topicIndex.sql)) throw new StateCorruptError('topic publication custody guard is missing');
    const topicTable = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='topic_publications'").get();
    if (!topicTable?.sql || !/CHECK\s*\(provider\s+IN\s*\('codex',\s*'claude'\)\)/i.test(topicTable.sql) ||
      !/CHECK\s*\(status\s+IN\s*\('in_flight',\s*'unknown',\s*'published',\s*'not_published'\)\)/i.test(topicTable.sql)) {
      throw new StateCorruptError('topic publication custody constraints are missing');
    }
    const threadTable = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='thread_enrollments'").get();
    if (!threadTable?.sql || !/CHECK\s*\(state\s+IN\s*\('pending',\s*'ready',\s*'gap',\s*'unavailable'\)\)/i.test(threadTable.sql)) {
      throw new StateCorruptError('thread enrollment state constraints are missing');
    }
  }
  };
}

module.exports = { createSchemaValidation };
