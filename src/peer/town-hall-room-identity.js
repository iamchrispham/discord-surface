'use strict';

try {
  module.exports = require('../../dist/peer/town-hall-room-identity.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/peer/town-hall-room-identity.js'")) throw error;
  throw new Error('discord-surface town hall room identity build is missing; run npm run build before starting', { cause: error });
}
