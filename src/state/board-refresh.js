'use strict';

try {
  module.exports = require('../../dist/state/board-refresh.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/state/board-refresh.js'")) throw error;
  throw new Error('discord-surface board refresh state build is missing; run npm run build before starting', { cause: error });
}
