'use strict';

try {
  module.exports = require('../../dist/state/decision.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/state/decision.js'")) throw error;
  throw new Error('discord-surface decision state build is missing; run npm run build before starting', { cause: error });
}
