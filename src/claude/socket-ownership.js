'use strict';

try {
  module.exports = require('../../dist/claude/socket-ownership.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("../../dist/claude/socket-ownership.js")) throw error;
  throw new Error('discord-surface Claude socket ownership build is missing; run npm run build before starting', { cause: error });
}
