const test = require('node:test');
const assert = require('node:assert/strict');
const { roomDigitPolicies } = require('./policy-inventory-analysis');

test('switch case bindings stay inside their lexical scope', () => {
  const consumer = {
    file: 'peer/switch-case-room-policy.ts',
    text: String.raw`function validateTownHallRoom(room, kind) {
      switch (kind) {
        case 0: let pattern = '^x$'; break;
      }
      const pattern = '^\\d{1,21}$';
      return RegExp(pattern).test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([consumer]), { [consumer.file]: 1 });
});

test('whole-room regex helpers follow contextual ESM and CJS calls', () => {
  const esmHelper = {
    file: 'peer/whole-room-esm-helper.mts',
    text: String.raw`export function checkIds(room) {
      return /^\d{1,21}$/.test(room.guildId);
    }`,
  };
  const esmConsumer = {
    file: 'peer/whole-room-esm-consumer.mjs',
    text: String.raw`import { checkIds } from './whole-room-esm-helper.mjs';
    export function validateTownHallRoom(room) { return checkIds(room); }`,
  };
  assert.deepEqual(roomDigitPolicies([esmHelper, esmConsumer]), { [esmHelper.file]: 1 });

  const esmNameHelper = {
    file: 'peer/whole-room-esm-name-helper.mts',
    text: String.raw`export function checkName(room) {
      return /^\d{1,21}$/.test(room.name);
    }`,
  };
  const esmNameConsumer = {
    file: 'peer/whole-room-esm-name-consumer.mjs',
    text: String.raw`import { checkName } from './whole-room-esm-name-helper.mjs';
    export function validateTownHallRoom(room) { return checkName(room); }`,
  };
  assert.deepEqual(roomDigitPolicies([esmNameHelper, esmNameConsumer]), {});

  const cjsHelper = {
    file: 'peer/whole-room-cjs-helper.cts',
    text: String.raw`function checkIds(room) {
      return /^\d{1,21}$/.test(room.channelId);
    }
    module.exports = checkIds;`,
  };
  const cjsConsumer = {
    file: 'peer/whole-room-cjs-consumer.cjs',
    text: String.raw`const checkIds = require('./whole-room-cjs-helper.cjs');
    function validateTownHallRoom(room) { return checkIds(room); }`,
  };
  assert.deepEqual(roomDigitPolicies([cjsHelper, cjsConsumer]), { [cjsHelper.file]: 1 });

  const nonRoomConsumer = {
    file: 'peer/whole-room-cjs-message-consumer.cjs',
    text: String.raw`const checkIds = require('./whole-room-cjs-helper.cjs');
    function validateMessage(room) { return checkIds(room); }`,
  };
  assert.deepEqual(roomDigitPolicies([cjsHelper, nonRoomConsumer]), {});
});

test('array bindings without sources stay unknown and initialized arrays retain aliases', () => {
  const parameter = {
    file: 'peer/uninitialized-array-parameter.ts',
    text: String.raw`function ordinary([name, value]) { void name; void value; }`,
  };
  const caught = {
    file: 'peer/uninitialized-array-catch.ts',
    text: String.raw`try { throw []; } catch ([name, value]) { void name; void value; }`,
  };
  const iteration = {
    file: 'peer/uninitialized-array-iteration.ts',
    text: String.raw`function ordinary(entries) {
      for (const [name, value] of entries) { void name; void value; }
    }`,
  };
  const unknownRoomField = {
    file: 'peer/uninitialized-array-room-source.ts',
    text: String.raw`function validateTownHallRoom(entries) {
      for (const [name, value] of entries) {
        if (/^\d{1,21}$/.test(value)) return true;
      }
      return false;
    }`,
  };
  for (const record of [parameter, caught, iteration, unknownRoomField]) {
    assert.deepEqual(roomDigitPolicies([record]), {});
  }

  const initialized = {
    file: 'peer/initialized-array-room-fields.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const [guildId] = [room.guildId];
      return /^\d{1,21}$/.test(guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([initialized]), { [initialized.file]: 1 });
});

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

test('room-field fallbacks include only room identifier alternatives', () => {
  const nullishFallback = {
    file: 'peer/nullish-room-fallback.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\d{1,21}$/.test(room.guildId ?? room.channelId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([nullishFallback]), { [nullishFallback.file]: 1 });

  const logicalFallback = {
    file: 'peer/logical-room-fallback.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\d{1,21}$/.test(room.guildId || room.channelId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([logicalFallback]), { [logicalFallback.file]: 1 });

  const mixedFallback = {
    file: 'peer/mixed-room-fallback.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\d{1,21}$/.test(room.guildId ?? room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([mixedFallback]), {});
});

test('regex aliases assigned after declaration retain binding-aware inputs', () => {
  const consumer = {
    file: 'peer/assigned-room-pattern.ts',
    text: String.raw`function validateTownHallRoom(room) {
      let pattern;
      pattern = /^\d{1,21}$/;
      return pattern.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([consumer]), { [consumer.file]: 1 });

  const negativeConsumer = {
    file: 'peer/assigned-room-pattern-negative.ts',
    text: String.raw`function validateTownHallRoom(room) {
      let pattern;
      pattern = /^\d{1,21}$/;
      return pattern.test(room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([negativeConsumer]), {});
});

test('destructured regex aliases from namespaces retain room inputs', () => {
  const pattern = {
    file: 'peer/namespace-pattern.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const consumer = {
    file: 'peer/namespace-pattern-consumer.ts',
    text: String.raw`import * as patterns from './namespace-pattern';
    const { ROOM_ID: pattern } = patterns;
    function validateTownHallRoom(room) { return pattern.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([pattern, consumer]), { [pattern.file]: 1 });

  const negativeConsumer = {
    file: 'peer/namespace-pattern-negative.ts',
    text: String.raw`import * as patterns from './namespace-pattern';
    const { ROOM_ID: pattern } = patterns;
    function validateTownHallRoom(room) { return pattern.test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([pattern, negativeConsumer]), {});
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

test('stored local factory result preserves test room input', () => {
  const storedTest = {
    file: 'peer/stored-pattern-test.ts',
    text: String.raw`function getPattern() { return /^\\d{1,21}$/; }
    function validateTownHallRoom(room) { const pattern = getPattern(); return pattern.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([storedTest]), { [storedTest.file]: 1 });
});

test('stored local factory result preserves exec room input', () => {
  const storedExec = {
    file: 'peer/stored-pattern-exec.ts',
    text: String.raw`function getPattern() { return /^\\d{1,21}$/; }
    function validateTownHallRoom(room) { const pattern = getPattern(); return pattern.exec(room.channelId); }`,
  };
  assert.deepEqual(roomDigitPolicies([storedExec]), { [storedExec.file]: 1 });
});

test('stored local factory result ignores unrelated fields', () => {
  const storedNegative = {
    file: 'peer/stored-pattern-negative.ts',
    text: String.raw`function getPattern() { return /^\\d{1,21}$/; }
    function validateTownHallRoom(room) { const pattern = getPattern(); return pattern.test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([storedNegative]), {});
});

test('RegExp parameter shadows are not treated as the native constructor', () => {
  const parameterShadow = {
    file: 'peer/regexp-parameter-shadow.ts',
    text: String.raw`function validateTownHallRoom(room, RegExp) {
      return RegExp('^\\d{1,21}$').test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([parameterShadow]), {});
});

test('RegExp local shadows are not treated as the native constructor', () => {
  const localShadow = {
    file: 'peer/regexp-local-shadow.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const RegExp = makeMatcher;
      return RegExp('^\\d{1,21}$').test(room.channelId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([localShadow]), {});
});

test('array destructuring preserves source positions and room field identities', () => {
  const consumer = {
    file: 'peer/array-room-destructure.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const [, guildId, channelId] = [room.name, room.guildId, room.channelId];
      return /^\\d{1,21}$/.test(guildId) && /^\\d{1,20}$/.test(channelId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([consumer]), { [consumer.file]: 2 });
});

test('array destructuring ignores unrelated room fields', () => {
  const unrelated = {
    file: 'peer/array-unrelated-destructure.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const [unused, guildId] = [room.guildId, room.name];
      return /^\\d{1,21}$/.test(guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([unrelated]), {});
});

test('fixed-key array callbacks preserve finite room fields', () => {
  const some = {
    file: 'peer/fixed-key-some.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return !['guildId', 'channelId'].some(key => !/^\d{1,21}$/.test(room[key]));
    }`,
  };
  assert.deepEqual(roomDigitPolicies([some]), { [some.file]: 1 });

  const filter = {
    file: 'peer/fixed-key-filter.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return ['guildId', 'channelId'].filter(key => !/^\d{1,21}$/.test(room[key])).length === 0;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([filter]), { [filter.file]: 1 });

  const mapped = {
    file: 'peer/fixed-key-map.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return ['guildId', 'channelId'].map(key => /^\d{1,21}$/.test(room[key])).every(Boolean);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([mapped]), { [mapped.file]: 1 });

  const ordinary = {
    file: 'peer/fixed-key-some-ordinary.ts',
    text: String.raw`function validateRoom(room) {
      return !['guildId', 'channelId'].some(key => !/^\d{1,21}$/.test(room[key]));
    }`,
  };
  assert.deepEqual(roomDigitPolicies([ordinary]), {});

  const dynamic = {
    file: 'peer/dynamic-key-some.ts',
    text: String.raw`function validateTownHallRoom(room, keys) {
      return !keys.some(key => !/^\d{1,21}$/.test(room[key]));
    }`,
  };
  assert.deepEqual(roomDigitPolicies([dynamic]), {});
});

test('namespace re-exports retain imported regex policies', () => {
  const pattern = {
    file: 'peer/namespace-reexport-pattern.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const barrel = {
    file: 'peer/namespace-reexport-barrel.ts',
    text: String.raw`export * as patterns from './namespace-reexport-pattern';`,
  };
  const consumer = {
    file: 'peer/namespace-reexport-consumer.ts',
    text: String.raw`import { patterns } from './namespace-reexport-barrel';
      function validateTownHallRoom(room) { return patterns.ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([pattern, barrel, consumer]), { [pattern.file]: 1 });

  const negativeConsumer = {
    file: 'peer/namespace-reexport-negative.ts',
    text: String.raw`import { patterns } from './namespace-reexport-barrel';
      function validateTownHallRoom(room) { return patterns.ROOM_ID.test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([pattern, barrel, negativeConsumer]), {});
});

test('local import and export statements retain regex policies', () => {
  const pattern = {
    file: 'peer/local-import-export-pattern.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const barrel = {
    file: 'peer/local-import-export-barrel.ts',
    text: String.raw`import { ROOM_ID } from './local-import-export-pattern';
      export { ROOM_ID };`,
  };
  const consumer = {
    file: 'peer/local-import-export-consumer.ts',
    text: String.raw`import { ROOM_ID } from './local-import-export-barrel';
      function validateTownHallRoom(room) { return ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([pattern, barrel, consumer]), { [pattern.file]: 1 });

  const negativeConsumer = {
    file: 'peer/local-import-export-negative-consumer.ts',
    text: String.raw`import { ROOM_ID } from './local-import-export-barrel';
      function validateTownHallRoom(room) { return ROOM_ID.test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([pattern, barrel, negativeConsumer]), {});
});

test('instance regex fields follow direct and local constructor receivers', () => {
  const direct = {
    file: 'peer/direct-instance-pattern.ts',
    text: String.raw`class Patterns { ROOM_ID = /^\d{1,21}$/; }
      function validateTownHallRoom(room) { return new Patterns().ROOM_ID.test(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([direct]), { [direct.file]: 1 });

  const local = {
    file: 'peer/local-instance-pattern.ts',
    text: String.raw`class Patterns { ROOM_ID = /^\d{1,21}$/; }
      function validateTownHallRoom(room) {
        const patterns = new Patterns();
        return patterns.ROOM_ID.test(room.guildId);
      }`,
  };
  assert.deepEqual(roomDigitPolicies([local]), { [local.file]: 1 });

  const ordinary = {
    file: 'peer/instance-pattern-ordinary.ts',
    text: String.raw`class Patterns { ROOM_ID = /^\d{1,21}$/; }
      function validateTownHallRoom(room) { return new Patterns().ROOM_ID.test(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([ordinary]), {});

});

test('static regex getters follow direct return values without executing code', () => {
  const getter = {
    file: 'peer/static-getter-pattern.ts',
    text: String.raw`class TownHallPatterns {
      static get ROOM_ID() { return /^\d{1,21}$/; }
    }
    function validateTownHallRoom(room) {
      return TownHallPatterns.ROOM_ID.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([getter]), { [getter.file]: 1 });

  const ordinary = {
    file: 'peer/static-getter-ordinary.ts',
    text: String.raw`class TownHallPatterns {
      static get ROOM_ID() { return /^\d{1,21}$/; }
    }
    function validateTownHallRoom(room) {
      return TownHallPatterns.ROOM_ID.test(room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([ordinary]), {});
});

test('shadowed imported helpers do not contribute their regex policy', () => {
  const helper = {
    file: 'peer/shadowed-room-helper.ts',
    text: String.raw`export function check(value) { return /^\d{1,22}$/.test(value); }`,
  };
  const ordinary = {
    file: 'peer/imported-room-helper.ts',
    text: String.raw`import { check } from './shadowed-room-helper';
      function validateTownHallRoom(room) { return check(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([helper, ordinary]), { [helper.file]: 1 });

  const parameterShadow = {
    file: 'peer/parameter-shadow-room-helper.ts',
    text: String.raw`import { check } from './shadowed-room-helper';
      function validateTownHallRoom(room, check) { return check(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([helper, parameterShadow]), {});

  const functionShadow = {
    file: 'peer/function-shadow-room-helper.ts',
    text: String.raw`import { check } from './shadowed-room-helper';
      function validateTownHallRoom(room) {
        function check(value) { return value === room.guildId; }
        return check(room.guildId);
      }`,
  };
  assert.deepEqual(roomDigitPolicies([helper, functionShadow]), {});

  const catchShadow = {
    file: 'peer/catch-shadow-room-helper.ts',
    text: String.raw`import { check } from './shadowed-room-helper';
      function validateTownHallRoom(room) {
        try { throw value => value === room.guildId; }
        catch (check) { return check(room.guildId); }
      }`,
  };
  assert.deepEqual(roomDigitPolicies([helper, catchShadow]), {});

  const ordinaryField = {
    file: 'peer/imported-room-helper-ordinary.ts',
    text: String.raw`import { check } from './shadowed-room-helper';
      function validateTownHallRoom(room) { return check(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([helper, ordinaryField]), {});
});

test('local object destructuring keeps a regex connected to its room field', () => {
  const consumer = {
    file: 'peer/local-object-destructure.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const patterns = { ROOM_ID: /^\d{1,21}$/ };
      const { ROOM_ID } = patterns;
      return ROOM_ID.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([consumer]), { [consumer.file]: 1 });

  const negativeConsumer = {
    file: 'peer/local-object-destructure-negative.ts',
    text: String.raw`function validateTownHallRoom(room) {
      const patterns = { ROOM_ID: /^\d{1,21}$/ };
      const { ROOM_ID } = patterns;
      return ROOM_ID.test(room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([negativeConsumer]), {});
});

test('direct dynamic regex imports are indexed without counting unrelated fields', () => {
  const pattern = {
    file: 'peer/direct-dynamic-pattern.ts',
    text: String.raw`export const ROOM_ID = /^\d{1,21}$/;`,
  };
  const consumer = {
    file: 'peer/direct-dynamic-consumer.ts',
    text: String.raw`async function validateTownHallRoom(room) {
      return (await import('./direct-dynamic-pattern')).ROOM_ID.test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([pattern, consumer]), { [pattern.file]: 1 });

  const negativeConsumer = {
    file: 'peer/direct-dynamic-negative-consumer.ts',
    text: String.raw`async function validateTownHallRoom(room) {
      return (await import('./direct-dynamic-pattern')).ROOM_ID.test(room.name);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([pattern, negativeConsumer]), {});
});

test('room identifier origin survives trim and toString calls', () => {
  const trimmed = {
    file: 'peer/trimmed-room-identifier.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\d{1,21}$/.test(room.guildId.trim());
    }`,
  };
  assert.deepEqual(roomDigitPolicies([trimmed]), { [trimmed.file]: 1 });

  const stringified = {
    file: 'peer/stringified-room-identifier.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\d{1,21}$/.test(room.guildId.toString());
    }`,
  };
  assert.deepEqual(roomDigitPolicies([stringified]), { [stringified.file]: 1 });

  const negativeConsumer = {
    file: 'peer/normalized-ordinary-field.ts',
    text: String.raw`function validateTownHallRoom(room) {
      return /^\d{1,21}$/.test(room.name.trim());
    }`,
  };
  assert.deepEqual(roomDigitPolicies([negativeConsumer]), {});
});

test('for-of room fields retain every finite iterable source', () => {
  const consumer = {
    file: 'peer/for-of-room-policy.ts',
    text: String.raw`function validateTownHallRoom(room) {
      for (const value of [room.name, room.guildId, room.channelId]) {
        if (/^\d{1,21}$/.test(value)) return true;
      }
      return false;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([consumer]), { [consumer.file]: 1 });

  const ordinary = {
    file: 'peer/for-of-room-policy-ordinary.ts',
    text: String.raw`function validateTownHallRoom(room) {
      for (const value of [room.name]) {
        if (/^\d{1,21}$/.test(value)) return true;
      }
      return false;
    }`,
  };
  assert.deepEqual(roomDigitPolicies([ordinary]), {});
});

test('default regex parameters apply only when the call omits that argument', () => {
  const consumer = {
    file: 'peer/default-room-pattern.ts',
    text: String.raw`function matches(value, pattern = /^\d{1,21}$/) {
      return pattern.test(value);
    }
    function validateTownHallRoom(room) { return matches(room.guildId); }`,
  };
  assert.deepEqual(roomDigitPolicies([consumer]), { [consumer.file]: 1 });

  const ordinary = {
    file: 'peer/default-room-pattern-ordinary.ts',
    text: String.raw`function matches(value, pattern = /^\d{1,21}$/) {
      return pattern.test(value);
    }
    function validateTownHallRoom(room) { return matches(room.name); }`,
  };
  assert.deepEqual(roomDigitPolicies([ordinary]), {});

  const explicitPattern = {
    file: 'peer/default-room-pattern-explicit.ts',
    text: String.raw`function matches(value, pattern = /^\d{1,22}$/) {
      return pattern.test(value);
    }
    function validateTownHallRoom(room) {
      return matches(room.guildId, /^\d{1,21}$/);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([explicitPattern]), { [explicitPattern.file]: 1 });
});

test('native RegExp constructor aliases retain lexical shadowing', () => {
  const consumer = {
    file: 'peer/native-regexp-alias.ts',
    text: String.raw`const NativeRegExp = RegExp;
    function validateTownHallRoom(room) {
      return new NativeRegExp('^\\d{1,21}$').test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([consumer]), { [consumer.file]: 1 });

  const shadowed = {
    file: 'peer/native-regexp-alias-shadowed.ts',
    text: String.raw`function validateTownHallRoom(room, RegExp) {
      const NativeRegExp = RegExp;
      return new NativeRegExp('^\\d{1,21}$').test(room.guildId);
    }`,
  };
  assert.deepEqual(roomDigitPolicies([shadowed]), {});
});

test('same-owner this helpers retain room identity and reject ordinary data', () => {
  const classValidator = {
    file: 'peer/this-class-room-policy.ts',
    text: String.raw`class ClassRoomValidator {
      checkId(value) { return /^\d{1,22}$/.test(value); }
      validateTownHallRoom(room) { return this.checkId(room.guildId); }
    }`,
  };
  const objectValidator = {
    file: 'peer/this-object-room-policy.ts',
    text: String.raw`const ObjectRoomValidator = {
      checkId(value) { return /^\d{1,22}$/.test(value); },
      validateTownHallRoom(room) { return this.checkId(room.channelId); },
    };`,
  };
  const ordinary = {
    file: 'peer/this-room-policy-ordinary.ts',
    text: String.raw`class OrdinaryRoomValidator {
      checkId(value) { return /^\d{1,22}$/.test(value); }
      validateTownHallRoom(room) { return this.checkId(room.name); }
    }`,
  };
  const differentOwner = {
    file: 'peer/this-room-policy-different-owner.ts',
    text: String.raw`class IdHelper {
      checkId(value) { return /^\d{1,22}$/.test(value); }
    }
    class RoomValidator {
      validateTownHallRoom(room) { return this.checkId(room.guildId); }
    }`,
  };

  assert.deepEqual(roomDigitPolicies([
    classValidator,
    objectValidator,
    ordinary,
    differentOwner,
  ]), {
    [classValidator.file]: 1,
    [objectValidator.file]: 1,
  });
});
