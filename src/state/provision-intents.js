'use strict';

function createProvisionIntentHandlers({ assertProvider, assertUuid, assertConductorId, assertRepoKey, assertText, assertEndpoint, BindingError, now }) {
  return {
    beginProvisionIntent(surface, intent) {
      const provider = assertProvider(intent.provider);
      const nativeId = assertUuid(intent.nativeId);
      const conductorId = intent.conductorId == null ? null : assertConductorId(intent.conductorId);
      const repoKey = intent.repoKey == null ? null : assertRepoKey(intent.repoKey);
      if (Boolean(conductorId) !== Boolean(repoKey)) throw new BindingError('conductorId and repoKey must be provided together');
      for (const key of ['guildId', 'categoryId', 'workspace', 'marker']) assertText(intent[key], key, 4096);
      const endpoint = intent.endpoint == null ? null : assertEndpoint(intent.endpoint);
      const taskName = intent.taskName == null ? null : assertText(intent.taskName, 'taskName', 90);
      return surface.transaction(() => {
        const existing = conductorId
          ? surface.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND conductor_id=?').get(provider, conductorId)
          : surface.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
        const legacy = conductorId && !existing
          ? surface.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId)
          : null;
        let adopted = existing || legacy;
        if (legacy && !legacy.conductor_id) {
          const sameLegacy = legacy.guild_id === intent.guildId && legacy.category_id === intent.categoryId && legacy.workspace === intent.workspace && legacy.endpoint === endpoint;
          if (!sameLegacy) throw new BindingError('legacy provision intent does not match the requested identity');
          surface.db.prepare('UPDATE provision_intents SET conductor_id=?, repo_key=?, marker=?, task_name=?, updated_at=? WHERE provider=? AND native_id=?')
            .run(conductorId, repoKey, intent.marker, taskName, now(), provider, nativeId);
          adopted = surface.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
        }
        if (adopted) {
          const same = adopted.guild_id === intent.guildId && adopted.category_id === intent.categoryId && adopted.workspace === intent.workspace && adopted.endpoint === endpoint && adopted.marker === intent.marker && (adopted.conductor_id || conductorId) === conductorId && (adopted.repo_key || repoKey) === repoKey;
          if (!same) throw new BindingError('provision intent does not match the requested identity');
          if (conductorId && adopted.native_id !== nativeId) throw new BindingError('conductor successor requires an explicit handoff');
          return { ...surface.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId), fresh: false };
        }
        const timestamp = now();
        surface.db.prepare(`INSERT INTO provision_intents(provider, native_id, conductor_id, repo_key, guild_id, category_id, workspace, endpoint, marker, task_name, state, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(provider, nativeId, conductorId, repoKey, intent.guildId, intent.categoryId, intent.workspace, endpoint, intent.marker, taskName, timestamp, timestamp);
        surface.receipt(null, 'provision-intent', { provider, nativeId, conductorId, repoKey, categoryId: intent.categoryId });
        const row = conductorId
          ? surface.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND conductor_id=?').get(provider, conductorId)
          : surface.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
        return { ...row, fresh: true };
      });
    },

    completeProvisionIntent(surface, provider, nativeId, channelId, conductorId = null) {
      assertProvider(provider);
      assertUuid(nativeId);
      assertText(channelId, 'channelId', 128);
      if (conductorId) assertConductorId(conductorId);
      return surface.transaction(() => {
        const result = conductorId
          ? surface.db.prepare("UPDATE provision_intents SET channel_id=?, native_id=?, state='resolved', updated_at=? WHERE provider=? AND conductor_id=?").run(channelId, nativeId, now(), provider, conductorId)
          : surface.db.prepare("UPDATE provision_intents SET channel_id=?, state='resolved', updated_at=? WHERE provider=? AND native_id=?").run(channelId, now(), provider, nativeId);
        if (Number(result.changes) !== 1) throw new BindingError('provision intent is unknown');
        surface.receipt(null, 'provision-resolved', { provider, nativeId, conductorId, channelId });
        return conductorId
          ? surface.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND conductor_id=?').get(provider, conductorId)
          : surface.db.prepare('SELECT * FROM provision_intents WHERE provider=? AND native_id=?').get(provider, nativeId);
      });
    },
  };
}

module.exports = { createProvisionIntentHandlers };
