'use strict';

try {
  module.exports = require('../dist/decision-canonical.js');
} catch (error) {
  if (
    error?.code !== 'MODULE_NOT_FOUND' ||
    !String(error?.message ?? '').includes('dist/decision-canonical.js')
  ) {
    throw error;
  }
  throw new Error('decision-canonical build is missing; run npm run build first', {
    cause: error,
  });
}
