const test = require('node:test');
const assert = require('node:assert/strict');
const { roomDigitPolicies } = require('./policy-inventory-analysis');

test('runtime CJS and MJS imports resolve to their TypeScript source files', () => {
  const ctsPattern = {
    file: 'peer/runtime-cjs-pattern.cts',
    text: String.raw`exports.ROOM_ID = /^\d{1,21}$/;`,
  };
  const cjsConsumer = {
    file: 'peer/runtime-cjs-consumer.cjs',
    text: String.raw`const { ROOM_ID } = require('./runtime-cjs-pattern.cjs');
    function validateTownHallRoom(room) { return ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([ctsPattern, cjsConsumer]), { [ctsPattern.file]: 1 });
  const cjsNegativeConsumer = {
    file: 'peer/runtime-cjs-negative-consumer.cjs',
    text: String.raw`const { ROOM_ID } = require('./runtime-cjs-pattern.cjs');
    function validateTownHallRoom(room) { return ROOM_ID.test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([ctsPattern, cjsNegativeConsumer]), {});

  const mtsPattern = {
    file: 'peer/runtime-mjs-pattern.mts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const mjsConsumer = {
    file: 'peer/runtime-mjs-consumer.mjs',
    text: String.raw`import { ROOM_ID } from './runtime-mjs-pattern.mjs';
    function validateTownHallRoom(room) { return ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([mtsPattern, mjsConsumer]), { [mtsPattern.file]: 1 });
  const mjsNegativeConsumer = {
    file: 'peer/runtime-mjs-negative-consumer.mjs',
    text: String.raw`import { ROOM_ID } from './runtime-mjs-pattern.mjs';
    function validateTownHallRoom(room) { return ROOM_ID.test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([mtsPattern, mjsNegativeConsumer]), {});
});

test('dynamic regex imports retain their declaration scope', () => {
  const pattern = {
    file: 'peer/dynamic-pattern.js',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const consumer = {
    file: 'peer/dynamic-consumer.js',
    text: String.raw`async function validateTownHallRoom(room) {
      const { ROOM_ID } = await import('./dynamic-pattern.js');
      return ROOM_ID.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([pattern, consumer]), { [pattern.file]: 1 });
  const negativeConsumer = {
    file: 'peer/dynamic-negative-consumer.js',
    text: String.raw`async function validateTownHallRoom(room) {
      const { ROOM_ID } = await import('./dynamic-pattern.js');
      return ROOM_ID.test(room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([pattern, negativeConsumer]), {});
});

test('borrowed String.match calls keep the regex connected to its input', () => {
  const consumer = {
    file: 'peer/borrowed-string-match.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return String.prototype.match.call(room.guildId, /^\d{1,21}$/) !== null;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([consumer]), { [consumer.file]: 1 });
  const negativeConsumer = {
    file: 'peer/borrowed-string-match-negative.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return String.prototype.match.call(room.name, /^\d{1,21}$/) !== null;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([negativeConsumer]), {});

  const localPatternConsumer = {
    file: 'peer/borrowed-string-match-local-pattern.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const ROOM_ID = /^\d{1,21}$/;
      return String.prototype.match.call(room.guildId, ROOM_ID) !== null;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([localPatternConsumer]), {
    [localPatternConsumer.file]: 1,
  });
  const localPatternNegativeConsumer = {
    file: 'peer/borrowed-string-match-local-pattern-negative.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const ROOM_ID = /^\d{1,21}$/;
      return String.prototype.match.call(room.name, ROOM_ID) !== null;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([localPatternNegativeConsumer]), {});

  const importedPattern = {
    file: 'peer/borrowed-string-match-pattern.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const importedPatternConsumer = {
    file: 'peer/borrowed-string-match-imported.ts',
    text: String.raw`import { ROOM_ID } from './borrowed-string-match-pattern';
    function validateTownHallRoom(room) {
      return String.prototype.match.call(room.guildId, ROOM_ID) !== null;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([importedPattern, importedPatternConsumer]), {
    [importedPattern.file]: 1,
  });
  const importedPatternNegativeConsumer = {
    file: 'peer/borrowed-string-match-imported-negative.ts',
    text: String.raw`import { ROOM_ID } from './borrowed-string-match-pattern';
    function validateTownHallRoom(room) {
      return String.prototype.match.call(room.name, ROOM_ID) !== null;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([importedPattern, importedPatternNegativeConsumer]), {});
});

test('local and imported pattern factories preserve returned regex inputs', () => {
  const localFactory = {
    file: 'peer/local-pattern-factory.ts',
    text: String.raw`function getPattern() { return /^\d{1,21}$/; }
    function validateTownHallRoom(room) { return getPattern().test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([localFactory]), { [localFactory.file]: 1 });
  const localNegativeFactory = {
    file: 'peer/local-pattern-factory-negative.ts',
    text: String.raw`function getPattern() { return /^\d{1,21}$/; }
    function validateTownHallRoom(room) { return getPattern().test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([localNegativeFactory]), {});

  const importedFactory = {
    file: 'peer/imported-pattern-factory.ts',
    text: String.raw`export function getPattern() { return /^\d{1,21}$/; }`,
  };
  const importedConsumer = {
    file: 'peer/imported-pattern-factory-consumer.ts',
    text: String.raw`import { getPattern } from './imported-pattern-factory';
    function validateTownHallRoom(room) { return getPattern().test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([importedFactory, importedConsumer]), {
    [importedFactory.file]: 1,
  });
  const importedNegativeConsumer = {
    file: 'peer/imported-pattern-factory-negative.ts',
    text: String.raw`import { getPattern } from './imported-pattern-factory';
    function validateTownHallRoom(room) { return getPattern().test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([importedFactory, importedNegativeConsumer]), {});
});
