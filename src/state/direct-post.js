'use strict';

try {
  const { createDirectPostHandlers, queryDirectPostRows } = require('../../dist/state/direct-post.js');
  module.exports = { createDirectPostHandlers, queryDirectPostRows };
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/state/direct-post.js'")) throw error;
  throw new Error('discord-surface direct post state build is missing; run npm run build before starting', { cause: error });
}
