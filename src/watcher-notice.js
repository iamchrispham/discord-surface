'use strict';

try {
  module.exports = require('../dist/watcher-notice.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/watcher-notice.js'")) throw error;
  throw new Error('discord-surface watcher notice build is missing; run npm run build before starting', { cause: error });
}
