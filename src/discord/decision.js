'use strict';

try {
  module.exports = require('../../dist/discord/decision.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/discord/decision.js'")) throw error;
  throw new Error('discord-surface decision Gateway build is missing; run npm run build before starting', { cause: error });
}
