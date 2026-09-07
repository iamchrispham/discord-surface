'use strict';

try {
  module.exports = require('../dist/attachments.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  throw new Error('discord-surface attachments build is missing; run npm run build before starting', { cause: error });
}
