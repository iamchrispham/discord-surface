'use strict'; function createConfigurationHandlers({ assertText, BindingError }) { function setConfig(values) {
    const allowed = ['operatorId', 'guildId', 'secretFile', 'codexCategoryId', 'claudeCategoryId'];
    const current = this.getConfig();
    const merged = { ...current };
    for (const key of allowed) {
      if (values[key] !== undefined) merged[key] = values[key];
      if (merged[key] !== undefined) assertText(merged[key], key, 4096);
    }
    for (const key of ['operatorId', 'guildId', 'secretFile']) {
      if (!merged[key]) throw new BindingError(`surface is not configured: missing ${key}`);
    }
    return this.transaction(() => {
      const stmt = this.db.prepare('INSERT INTO config(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for (const [key, value] of Object.entries(merged)) if (allowed.includes(key)) stmt.run(key, value);
      this.receipt(null, 'configured', { guildId: merged.guildId, operatorId: merged.operatorId });
      return merged;
    });
  }
function getConfig() {
    const rows = this.db.prepare('SELECT key, value FROM config').all();
    return Object.fromEntries(rows.map(row => [row.key, row.value]));
  }
function requireConfig() {
    const config = this.getConfig();
    for (const key of ['operatorId', 'guildId', 'secretFile']) {
      if (!config[key]) throw new BindingError(`surface is not configured: missing ${key}`);
    }
    return config;
  } return { setConfig, getConfig, requireConfig }; } module.exports = { createConfigurationHandlers };