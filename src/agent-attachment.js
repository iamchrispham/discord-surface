'use strict';

try {
  module.exports = require('../dist/agent-attachment.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/agent-attachment.js'")) throw error;
  throw new Error('discord-surface agent attachment build is missing; run npm run build before starting', { cause: error });
}
