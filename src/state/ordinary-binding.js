'use strict';

try {
  const { createOrdinaryBindingHandlers, hasOrdinaryBindingReceipt, hasOrdinaryPreflightReceipt } = require('../../dist/state/ordinary-binding.js');
  module.exports = { createOrdinaryBindingHandlers, hasOrdinaryBindingReceipt, hasOrdinaryPreflightReceipt };
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/state/ordinary-binding.js'")) throw error;
  throw new Error('discord-surface ordinary binding build is missing; run npm run build before starting', { cause: error });
}
