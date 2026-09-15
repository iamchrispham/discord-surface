'use strict';

try {
  module.exports = require('../../dist/state/interaction.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/state/interaction.js'")) throw error;
  throw new Error('discord-surface interaction state build is missing; run npm run build before starting', { cause: error });
}
