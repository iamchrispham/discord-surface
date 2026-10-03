'use strict';

try {
  module.exports = require('../../dist/state/town-hall-journal/index.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/state/town-hall-journal/index.js'")) throw error;
  throw new Error('discord-surface town-hall journal build is missing; run npm run build before starting', { cause: error });
}
