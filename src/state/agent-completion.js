'use strict';

try {
  module.exports = require('../../dist/state/agent-completion.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/state/agent-completion.js'")) throw error;
  throw new Error('discord-surface agent completion state build is missing; run npm run build before starting', { cause: error });
}
