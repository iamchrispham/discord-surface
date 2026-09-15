'use strict';

try {
  module.exports = require('../../dist/ordinary-bind/gateway-capability.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/ordinary-bind/gateway-capability.js'")) throw error;
  throw new Error('discord-surface Gateway capability build is missing; run npm run build before starting', { cause: error });
}
