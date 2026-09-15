'use strict';

try {
  module.exports = require('../dist/native.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/native.js'")) throw error;
  throw new Error('discord-surface native build is missing; run npm run build before starting', { cause: error });
}
