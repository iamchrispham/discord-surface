try {
  const { CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX, ORDINARY_RECEIPT_KINDS } = require('../../dist/ordinary/constants.js');
  module.exports = { CLAUDE_ENDPOINT_UNAVAILABLE_PREFIX, ORDINARY_RECEIPT_KINDS };
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND' || !String(error?.message || '').includes("Cannot find module '../../dist/ordinary/constants.js'")) throw error;
  throw new Error('discord-surface ordinary constants build is missing; run npm run build before starting', { cause: error });
}
