'use strict';

try {
  module.exports = require('../../dist/discord/handoff-fence.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/discord/handoff-fence.js'")) throw error;
  throw new Error('discord-surface handoff fence build is missing; run npm run build before starting', { cause: error });
}
