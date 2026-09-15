'use strict';

try {
  module.exports = require('../dist/acknowledgment.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/acknowledgment.js'")) throw error;
  throw new Error('discord-surface acknowledgment build is missing; run npm run build before starting', { cause: error });
}
