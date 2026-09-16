'use strict';

try {
  const {
    readTextFile,
    resolveAgentAddress,
    requestIdFor,
    resolveDedupeKey,
    resolveDirectBinding,
    runDirectPost,
    runWatcherNoticePost
  } = require('../dist/direct-post.js');
  module.exports = {
    readTextFile,
    resolveAgentAddress,
    requestIdFor,
    resolveDedupeKey,
    resolveDirectBinding,
    runDirectPost,
    runWatcherNoticePost
  };
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../dist/direct-post.js'")) throw error;
  throw new Error('discord-surface direct post build is missing; run npm run build before starting', { cause: error });
}
