'use strict';

try {
  module.exports = require('../../dist/ordinary-bind/channel-resolution.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/ordinary-bind/channel-resolution.js'")) throw error;
  throw new Error('discord-surface channel resolution build is missing; run npm run build before starting', { cause: error });
}
