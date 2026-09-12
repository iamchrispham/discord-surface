'use strict';

try {
  module.exports = require('../dist/native-transcript.js');
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/native-transcript.js'")) throw error;
  throw new Error('discord-surface native transcript build is missing; run npm run build before starting', { cause: error });
}
