'use strict';

try {
  module.exports = require('../dist/board-refresh.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/board-refresh.js'")) throw error;
  throw new Error('discord-surface board refresh build is missing; run npm run build before starting', { cause: error });
}
