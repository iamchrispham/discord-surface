'use strict';

try {
  module.exports = require('../dist/agent-presentation.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/agent-presentation.js'")) throw error;
  throw new Error('discord-surface agent presentation build is missing; run npm run build before starting', { cause: error });
}
