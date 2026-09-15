'use strict';

try {
  module.exports = require('../../dist/state/courier-route/index.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/state/courier-route/index.js'")) throw error;
  throw new Error('discord-surface courier route build is missing; run npm run build before starting', { cause: error });
}
