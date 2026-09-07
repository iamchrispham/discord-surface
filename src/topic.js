'use strict';

try {
  module.exports = require('../dist/topic.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  throw new Error('discord-surface topic build is missing; run npm run build before starting', { cause: error });
}
