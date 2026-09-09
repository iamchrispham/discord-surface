'use strict';

try {
  module.exports = require('../dist/ordinary-codex.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/ordinary-codex.js'")) throw error;
  throw new Error('discord-surface ordinary Codex build is missing; run npm run build before starting', { cause: error });
}
