'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function isRoomField(node) {
  if (!ts.isPropertyAccessExpression(node) || !['guildId', 'channelId'].includes(node.name.text)) {
    return false;
  }
  return ts.isIdentifier(node.expression) && /^(?:room|townHall|townHallRoom)$/i.test(node.expression.text);
}

function regexInput(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'test' && parent.expression === current &&
        ts.isCallExpression(parent.parent)) {
      return parent.parent.arguments[0] || null;
    }
    current = parent;
  }
  return null;
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

function hasRoomFieldAlias(scope, subject, sourceFile) {
  if (!ts.isIdentifier(subject)) return false;
  let found = false;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === subject.text &&
        node.initializer && isRoomField(node.initializer)) {
      found = true;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && node.left.text === subject.text && isRoomField(node.right)) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope || sourceFile);
  return found;
}

function hasRoomKeyAlias(scope, subject) {
  if (!ts.isIdentifier(subject)) return false;
  let found = false;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === subject.text &&
        ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'ownDataProperty' && node.initializer.arguments.length === 2 &&
        ts.isStringLiteral(node.initializer.arguments[1]) &&
        ['guildId', 'channelId'].includes(node.initializer.arguments[1].text)) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope || sourceFile);
  return found;
}

function hasSplitRoomLengthBound(scope, subject, sourceFile) {
  const subjectText = subject.getText(sourceFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\W)${subjectText}\\s*\\.\\s*length\\s*(?:<=\\s*20|<\\s*21)(?:\\W|$)`).test(
    (scope || sourceFile).getText(sourceFile)
  );
}

function hasRoomFieldCall(scope, sourceFile) {
  const name = scope?.name && ts.isIdentifier(scope.name) ? scope.name.text : null;
  if (!name) return false;
  let found = false;
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name &&
        node.arguments.length === 1 && isRoomField(node.arguments[0])) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function roomFieldSubject(node, sourceFile) {
  const subject = regexInput(node);
  if (!subject) return false;
  const scope = enclosingFunction(node) || sourceFile;
  return isRoomField(subject) || hasRoomFieldAlias(scope, subject, sourceFile) || hasRoomFieldCall(scope, sourceFile);
}

function isTownHallRoomOwner(node) {
  const scope = enclosingFunction(node);
  if (!scope?.name || !ts.isIdentifier(scope.name) || scope.name.text !== 'isTownHallRoom') return false;
  const subject = regexInput(node);
  return Boolean(subject && hasRoomKeyAlias(scope, subject));
}

function isSplitRoomDigitPolicy(node, sourceFile, pattern) {
  if (!/(?:\\[dD]|\[0-9\])(?:\+|\*|\{1,\})/.test(pattern)) return false;
  const subject = regexInput(node);
  if (!subject) return false;
  const scope = enclosingFunction(node) || sourceFile;
  return roomFieldSubject(node, sourceFile) && hasSplitRoomLengthBound(scope, subject, sourceFile);
}

function roomDigitPolicies(records) {
  const sites = {};
  for (const { file, text } of records) {
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const numeric = /\\[dD]|\[(?:\^)?0-9\]/;
    const visit = node => {
      let pattern = null;
      if (ts.isRegularExpressionLiteral(node)) pattern = node.text;
      else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
          ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' &&
          node.arguments?.length && ts.isStringLiteralLike(node.arguments[0])) {
        pattern = node.arguments[0].text;
      }
      const roomPolicy = pattern !== null && numeric.test(pattern) &&
        (isTownHallRoomOwner(node) || roomFieldSubject(node, ast) || isSplitRoomDigitPolicy(node, ast, pattern));
      if (roomPolicy) {
        sites[file] = (sites[file] || 0) + 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return sites;
}

test('room policy inventory records only town-hall room validators', () => {
  const src = path.join(PROJECT_ROOT, 'src');
  const references = {};
  const records = [];
  for (const relative of fs.readdirSync(src, { recursive: true })) {
    if (!/\.(?:ts|js)$/.test(relative)) continue;
    const text = fs.readFileSync(path.join(src, relative), 'utf8');
    records.push({ file: relative.split(path.sep).join('/'), text });
    const count = (text.match(/\bisTownHallRoom\b/g) || []).length;
    if (count) references[relative.split(path.sep).join('/')] = count;
  }
  assert.deepEqual(references, { 'peer/town-hall-plan.ts': 2, 'peer/town-hall-room-identity.ts': 2 });
  const expectedPolicies = { 'peer/town-hall-plan.ts': 2 };
  assert.deepEqual(roomDigitPolicies(records), expectedPolicies);
  const inline = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return /^\d{1,20}$/.test(room.guildId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, inline]), expectedPolicies);
  const constructor = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return new RegExp('^[0-9]{1,21}$').test(room.guildId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, constructor]), expectedPolicies);
  const directCall = { file: 'peer/future-room.ts', text: String.raw`function validateRoom(room) { return RegExp('^[0-9]{1,21}$').test(room.channelId); }` };
  assert.notDeepEqual(roomDigitPolicies([...records, directCall]), expectedPolicies);
  const unrelatedBounded = { file: 'peer/snowflake.ts', text: String.raw`function validateId(value) { return /^\d{1,20}$/.test(value); }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedBounded]), expectedPolicies);
  const unrelatedOwnerPattern = { file: 'peer/town-hall-plan.ts', text: String.raw`function isTownHallRoom(value) { return /^\d{1,20}$/.test(value); }` };
  assert.deepEqual(roomDigitPolicies([...records, unrelatedOwnerPattern]), expectedPolicies);
  const splitNeutral = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    return /^\d+$/.test(room.guildId) && room.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, splitNeutral]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const splitAlias = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    const value = room.channelId;
    return /^\d+$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, splitAlias]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const splitCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }
  function inspect(room) { return isSnowflake(room.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, splitCall]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const emptySplit = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    return /^\d*$/.test(room.guildId) && room.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptySplit]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const emptyAlias = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(room) {
    const value = room.channelId;
    return /^\d*$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyAlias]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const emptyCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d*$/.test(value) && value.length <= 20;
  }
  function inspect(room) { return isSnowflake(room.channelId); }` };
  assert.deepEqual(roomDigitPolicies([...records, emptyCall]), {
    ...expectedPolicies,
    'peer/snowflake.ts': 1
  });
  const ordinarySplit = { file: 'peer/snowflake.ts', text: String.raw`function validateSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinarySplit]), expectedPolicies);
  const ordinaryFieldSplit = { file: 'peer/snowflake.ts', text: String.raw`function inspectSnowflake(user) {
    return /^\d+$/.test(user.guildId) && user.guildId.length <= 20;
  }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinaryFieldSplit]), expectedPolicies);
  const ordinaryCall = { file: 'peer/snowflake.ts', text: String.raw`function isSnowflake(value) {
    return /^\d+$/.test(value) && value.length <= 20;
  }
  function inspect(user) { return isSnowflake(user.guildId); }` };
  assert.deepEqual(roomDigitPolicies([...records, ordinaryCall]), expectedPolicies);
  const copied = records.map(record => record.file === 'peer/town-hall-room-identity.ts'
    ? { ...record, text: record.text + inline.text } : record);
  assert.notDeepEqual(roomDigitPolicies(copied), expectedPolicies);
});
