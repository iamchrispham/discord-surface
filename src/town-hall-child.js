'use strict';

try {
  module.exports = require('../dist/town-hall-child.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/town-hall-child.js'")) throw error;
  throw new Error('discord-surface town-hall child build is missing; run npm run build before starting', { cause: error });
}
