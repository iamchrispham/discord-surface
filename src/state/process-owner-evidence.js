'use strict';

try {
  module.exports = require('../../dist/state/process-owner-evidence.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/state/process-owner-evidence.js'")) throw error;
  throw new Error('discord-surface process owner evidence build is missing; run npm run build before starting', { cause: error });
}
