'use strict';

try {
  const {
    CLAUDE_PROVIDERS,
    CLAUDE_HARNESSES,
    createOrdinaryClaudeBindingHandlers
  } = require('../../dist/state/ordinary-binding-claude.js');
  module.exports = { CLAUDE_PROVIDERS, CLAUDE_HARNESSES, createOrdinaryClaudeBindingHandlers };
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/state/ordinary-binding-claude.js'")) throw error;
  throw new Error('discord-surface ordinary Claude binding build is missing; run npm run build before starting', { cause: error });
}
