const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAttachments } = require('../src/attachments');

test('attachment CJS facade preserves defaults and rejects unsafe metadata', () => {
  const attachment = { url: 'https://example.invalid/file', filename: 'file', size: 0 };
  assert.deepEqual(normalizeAttachments(undefined), []);
  assert.deepEqual(normalizeAttachments(null), []);
  assert.deepEqual(normalizeAttachments([attachment]), [{ ...attachment, contentType: null }]);
  assert.throws(() => normalizeAttachments([{ ...attachment, url: 'file:///tmp/file' }]), {
    name: 'TypeError', message: 'attachment 0 url must be an http or https URL'
  });
  assert.throws(() => normalizeAttachments([{ ...attachment, size: Number.MAX_SAFE_INTEGER + 1 }]), {
    name: 'TypeError', message: 'attachment 0 size is invalid'
  });
});
