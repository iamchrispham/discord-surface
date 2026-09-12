'use strict';

try {
  module.exports = require('../dist/direct-post.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/direct-post.js'")) throw error;
  throw new Error('discord-surface direct post build is missing; run npm run build before starting', { cause: error });
}
