'use strict';

try {
  module.exports = require('../dist/agent-message.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/agent-message.js'")) throw error;
  throw new Error('discord-surface agent message build is missing; run npm run build before starting', { cause: error });
}
