'use strict';

try {
  const {
    readTextFile,
    requestIdFor,
    resolveDedupeKey,
    resolveDirectBinding,
    runDirectPost
  } = require('../dist/direct-post.js');
  module.exports = {
    readTextFile,
    requestIdFor,
    resolveDedupeKey,
    resolveDirectBinding,
    runDirectPost
  };
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/direct-post.js'")) throw error;
  throw new Error('discord-surface direct post build is missing; run npm run build before starting', { cause: error });
}
