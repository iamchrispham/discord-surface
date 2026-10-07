'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SOURCE_FILE_PATTERN = /\.(?:js|ts)$/;
const OUTCOME_NAMES = new Set(['state', 'readiness', 'status', 'result', 'outcome']);

const collectSourceFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const absolute = path.join(directory, entry.name);
  if (entry.isDirectory()) return collectSourceFiles(absolute);
  return SOURCE_FILE_PATTERN.test(entry.name) ? [absolute] : [];
});

const readSourceInventory = sourceRoot => collectSourceFiles(sourceRoot).map(absolute => ({
  relative: path.relative(sourceRoot, absolute).split(path.sep).join('/'),
  source: fs.readFileSync(absolute, 'utf8')
}));

const isIdentifierStart = character => /[A-Za-z_$]/.test(character);
const isIdentifierPart = character => /[A-Za-z0-9_$]/.test(character);
const REGEX_PREFIXES = new Set(['(', '{', '[', ',', ';', ':', '=', '==', '===', '!=', '!==', '!', '&&', '||', '??', '?', '=>', 'return', 'case', 'throw', 'else', 'do', 'in', 'of']);

const tokenizeSource = source => {
  const tokens = [];
  const newlineOffsets = [];
  for (let offset = 0; offset < source.length; offset += 1) {
    if (source[offset] === '\n') newlineOffsets.push(offset);
  }
  const lineAt = offset => {
    let low = 0;
    let high = newlineOffsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (newlineOffsets[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };
  let index = 0;
  let previous = null;
  const push = (type, value, start, end) => {
    const token = { type, value, start, end, line: lineAt(start) };
    tokens.push(token);
    previous = token;
  };
  const canStartRegex = () => !previous || REGEX_PREFIXES.has(previous.value);

  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '"' || character === "'") {
      const start = index;
      const quote = character;
      let escaped = false;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      push('string', source.slice(start + 1, Math.max(start + 1, index - 1)), start, index);
      continue;
    }
    if (character === '`') {
      const start = index;
      let escaped = false;
      let hasSubstitution = false;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '$' && source[index + 1] === '{') hasSubstitution = true;
        else if (current === '`') {
          index += 1;
          break;
        }
        index += 1;
      }
      const value = source.slice(start + 1, Math.max(start + 1, index - 1));
      push(hasSubstitution ? 'template-dynamic' : 'template', hasSubstitution ? null : value, start, index);
      continue;
    }
    if (character === '/' && canStartRegex()) {
      const start = index;
      let escaped = false;
      let inClass = false;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (escaped) escaped = false;
        else if (current === '\\') escaped = true;
        else if (current === '[') inClass = true;
        else if (current === ']') inClass = false;
        else if (current === '/' && !inClass) {
          index += 1;
          while (index < source.length && isIdentifierPart(source[index])) index += 1;
          break;
        }
        index += 1;
      }
      push('regex', null, start, index);
      continue;
    }
    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) index += 1;
      push('identifier', source.slice(start, index), start, index);
      continue;
    }
    if (/[0-9]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[0-9A-Za-z._]/.test(source[index])) index += 1;
      push('number', source.slice(start, index), start, index);
      continue;
    }
    const operator = ['===', '!==', '=>', '>=', '<=', '==', '!=', '&&', '||', '??', '?.', '++', '--'].find(value => source.startsWith(value, index));
    if (operator) {
      push('operator', operator, index, index + operator.length);
      index += operator.length;
      continue;
    }
    push('punctuation', character, index, index + 1);
    index += 1;
  }
  return tokens;
};

const findTokenPairs = tokens => {
  const pairs = new Map();
  const stacks = new Map([['(', []], ['{', []], ['[', []]]);
  const closing = new Map([[')', '('], ['}', '{'], [']', '[']]);
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (stacks.has(value)) {
      stacks.get(value).push(index);
      continue;
    }
    if (!closing.has(value)) continue;
    const stack = stacks.get(closing.get(value));
    const opening = stack.pop();
    if (opening === undefined) continue;
    pairs.set(opening, index);
    pairs.set(index, opening);
  }
  return pairs;
};

const isGapEnumElementAt = (tokens, index) => {
  const object = tokens[index]?.value;
  const property = tokens[index + 2];
  return (object === 'READINESS' || object === 'THREAD_STATES')
    && tokens[index + 1]?.value === '['
    && (property?.type === 'string' || property?.type === 'template')
    && property.value === 'GAP'
    && tokens[index + 3]?.value === ']';
};

const isGapValueAt = (tokens, index) => {
  const token = tokens[index];
  if (!token) return false;
  if ((token.type === 'string' || token.type === 'template') && token.value === 'gap') return true;
  return (token.value === 'READINESS' || token.value === 'THREAD_STATES')
    && ((tokens[index + 1]?.value === '.' && tokens[index + 2]?.value === 'GAP')
      || isGapEnumElementAt(tokens, index));
};

const findDelimitedEnd = (tokens, start, end, closingValue) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (value === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
    else if (value === closingValue && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
  }
  return end;
};

const COMPARISON_OPERATORS = new Set(['==', '===', '!=', '!==', '>', '>=', '<', '<=']);

const gapValueEnd = (tokens, index) => {
  if ((tokens[index]?.type === 'string' || tokens[index]?.type === 'template')) return index + 1;
  if ((tokens[index]?.value === 'READINESS' || tokens[index]?.value === 'THREAD_STATES')
    && tokens[index + 1]?.value === '.' && tokens[index + 2]?.value === 'GAP') return index + 3;
  if (isGapEnumElementAt(tokens, index)) return index + 4;
  return index + 1;
};

const isComparisonOperand = (tokens, index, start, end) => {
  let left = index - 1;
  while (left >= start && (tokens[left]?.value === '.' || tokens[left]?.type === 'identifier')) left -= 1;
  if (left >= start && COMPARISON_OPERATORS.has(tokens[left]?.value)) return true;
  let right = gapValueEnd(tokens, index);
  while (right < end && (tokens[right]?.value === '.' || tokens[right]?.type === 'identifier')) right += 1;
  return right < end && COMPARISON_OPERATORS.has(tokens[right]?.value);
};

const expressionHasGap = (tokens, start, end, aliases = new Set(), allowNestedCalls = false) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const callParentheses = [];
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    const insideCall = allowNestedCalls && callParentheses.some(Boolean);
    if ((parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 || insideCall)
      && !isComparisonOperand(tokens, index, start, end)
      && (isGapValueAt(tokens, index) || (tokens[index].type === 'identifier' && aliases.has(value)))) return true;
    if (value === '(') {
      const previous = tokens[index - 1];
      callParentheses.push(previous?.type === 'identifier' || [')', ']'].includes(previous?.value));
      parenDepth += 1;
    } else if (value === ')') {
      parenDepth -= 1;
      callParentheses.pop();
    }
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
  }
  return false;
};

const objectHasTopLevelStateGap = (tokens, openingIndex, closingIndex, pairs, aliases = new Set(), allowNestedCalls = false) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = openingIndex + 1; index < closingIndex; index += 1) {
    const value = tokens[index].value;
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && OUTCOME_NAMES.has(value)) {
      if (tokens[index + 1]?.value === ':') {
        const valueStart = index + 2;
        const valueEnd = findDelimitedEnd(tokens, valueStart, closingIndex, '}');
        if (valueHasGap(tokens, valueStart, valueEnd, pairs, aliases, allowNestedCalls)) return true;
      } else if (tokens[index].type === 'identifier'
        && aliases.has(value)
        && [',', '}'].includes(tokens[index + 1]?.value)) {
        return true;
      }
    }
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
  }
  return false;
};

const valueHasGap = (tokens, start, end, pairs, aliases = new Set(), allowNestedCalls = false) => {
  if (start >= end) return false;
  let valueStart = start;
  let valueEnd = end;
  while (tokens[valueEnd - 1]?.value === ';') valueEnd -= 1;
  while (tokens[valueStart]?.value === '(') {
    const closingIndex = pairs.get(valueStart);
    if (closingIndex !== valueEnd - 1) break;
    valueStart += 1;
    valueEnd = closingIndex;
  }
  if (valueStart >= valueEnd) return false;
  if (isGapValueAt(tokens, valueStart)
    && !isComparisonOperand(tokens, valueStart, valueStart, valueEnd)) return true;
  if (tokens[valueStart].type === 'identifier' && aliases.has(tokens[valueStart].value)
    && !isComparisonOperand(tokens, valueStart, valueStart, valueEnd)) return true;
  if (tokens[valueStart].value === '{') {
    const closingIndex = pairs.get(valueStart);
    return closingIndex !== undefined && closingIndex < valueEnd
      ? objectHasTopLevelStateGap(tokens, valueStart, closingIndex, pairs, aliases, allowNestedCalls)
      : false;
  }
  return expressionHasGap(tokens, valueStart, valueEnd, aliases, allowNestedCalls);
};

const findStatementEnd = (tokens, start, end) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const statementLine = tokens[start]?.line;
  const asiStarters = new Set(['function', 'const', 'let', 'var', 'if', 'return', 'for', 'while', 'switch', 'try', 'throw', 'class', 'export', 'import']);
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (index > start && tokens[index].line > statementLine && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0
      && asiStarters.has(value) && ['identifier', 'string', 'template', 'number'].includes(tokens[index - 1]?.type)) return index;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') {
      if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
      braceDepth -= 1;
    } else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (value === ';' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index + 1;
  }
  return end;
};

const findControlledStatementEnd = (tokens, start, end, pairs, includeElse = true) => {
  if (start >= end) return end;
  if (tokens[start].value === '{') return Math.min(end, (pairs.get(start) ?? end - 1) + 1);
  if (tokens[start].value === 'if' && tokens[start + 1]?.value === '(') {
    const conditionEnd = pairs.get(start + 1);
    if (conditionEnd === undefined) return findStatementEnd(tokens, start, end);
    const bodyStart = conditionEnd + 1;
    const bodyEnd = tokens[bodyStart]?.value === '{'
      ? Math.min(end, (pairs.get(bodyStart) ?? end - 1) + 1)
      : findControlledStatementEnd(tokens, bodyStart, end, pairs);
    if (includeElse && tokens[bodyEnd]?.value === 'else') return findControlledStatementEnd(tokens, bodyEnd + 1, end, pairs);
    return bodyEnd;
  }
  return findStatementEnd(tokens, start, end);
};

const findFunctionRanges = (tokens, pairs) => {
  const ranges = [];
  const classBodies = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== 'class') continue;
    for (let body = index + 1; body < tokens.length; body += 1) {
      if (tokens[body].value === '{') {
        const closing = pairs.get(body);
        if (closing !== undefined) classBodies.push({ opening: body, closing });
        break;
      }
      if ([';', '}'].includes(tokens[body].value)) break;
    }
  }
  const controlHeaders = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
  const isClassMethod = parameterOpening => {
    const methodName = tokens[parameterOpening - 1];
    if (!methodName || (methodName.type !== 'identifier' && methodName.value !== ']')
      || controlHeaders.has(methodName.value)) return false;
    return classBodies.some(({ opening, closing }) => (
      opening < parameterOpening && parameterOpening < closing
    ));
  };
  for (let opening = 0; opening < tokens.length; opening += 1) {
    if (tokens[opening].value !== '{') continue;
    const closing = pairs.get(opening);
    if (closing === undefined) continue;
    const previousIndex = opening - 1;
    if (tokens[previousIndex]?.value === '=>') {
      ranges.push({ start: previousIndex, opening, closing });
      continue;
    }
    if (tokens[previousIndex]?.value !== ')') continue;
    const parameterOpening = pairs.get(previousIndex);
    if (parameterOpening === undefined) continue;
    let start = parameterOpening - 1;
    while (start >= 0 && ![';', '{', '}'].includes(tokens[start].value)) {
      if (tokens[start].value === 'function') {
        ranges.push({ start, opening, closing });
        break;
      }
      start -= 1;
    }
    if (isClassMethod(parameterOpening)) {
      ranges.push({ start: parameterOpening - 1, opening, closing });
    }
  }
  const findArrowExpressionEnd = start => {
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    const statementLine = tokens[start]?.line;
    const asiStarters = new Set(['function', 'const', 'let', 'var', 'if', 'return', 'for', 'while', 'switch', 'try', 'throw', 'class', 'export', 'import']);
    for (let index = start; index < tokens.length; index += 1) {
      const value = tokens[index].value;
      if (index > start && tokens[index].line > statementLine && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0
        && asiStarters.has(value) && ['identifier', 'string', 'template', 'number'].includes(tokens[index - 1]?.type)) return index;
      if (value === '(') parenDepth += 1;
      else if (value === ')') {
        if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
        parenDepth -= 1;
      } else if (value === '{') braceDepth += 1;
      else if (value === '}') {
        if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
        braceDepth -= 1;
      } else if (value === '[') bracketDepth += 1;
      else if (value === ']') bracketDepth -= 1;
      else if (value === ';' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index + 1;
      else if (value === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) return index;
    }
    return tokens.length;
  };
  for (let arrow = 0; arrow < tokens.length; arrow += 1) {
    if (tokens[arrow].value !== '=>' || tokens[arrow + 1]?.value === '{') continue;
    const bodyStart = arrow + 1;
    const bodyEnd = findArrowExpressionEnd(bodyStart);
    ranges.push({
      start: arrow,
      opening: bodyStart,
      closing: bodyEnd - 1,
      bodyStart,
      bodyEnd,
      expression: true
    });
  }
  return ranges;
};

const findIfDecision = (tokens, triggerIndex, pairs) => {
  let best = null;
  for (let index = triggerIndex; index >= 0; index -= 1) {
    if (tokens[index].value !== 'if' || tokens[index + 1]?.value !== '(') continue;
    const closingCondition = pairs.get(index + 1);
    if (closingCondition === undefined || triggerIndex > closingCondition) continue;
    if (!best || closingCondition - index < best.closingCondition - best.start) {
      best = { start: index, closingCondition };
    }
  }
  return best;
};

const findFunctionDecision = (ranges, triggerIndex) => {
  const containing = ranges
    .filter(range => range.expression
      ? range.bodyStart <= triggerIndex && triggerIndex < range.bodyEnd
      : range.opening < triggerIndex && triggerIndex < range.closing)
    .sort((left, right) => (left.closing - left.opening) - (right.closing - right.opening));
  if (containing[0]) return containing[0];
  return ranges
    .filter(range => range.start < triggerIndex
      && (range.expression ? triggerIndex < range.bodyStart : triggerIndex < range.opening))
    .sort((left, right) => left.opening - right.opening)[0] || null;
};

const findStatementRange = (tokens, triggerIndex) => {
  let start = triggerIndex;
  while (start > 0 && ![';', '{', '}'].includes(tokens[start - 1].value)) start -= 1;
  return { start, end: findStatementEnd(tokens, start, tokens.length), opening: null };
};

const isNegatedDeadlineCondition = (tokens, conditionStart, triggerIndex) => {
  let cursor = triggerIndex - 1;
  while (cursor >= conditionStart && tokens[cursor].value === '(') cursor -= 1;
  let negated = false;
  while (cursor >= conditionStart && tokens[cursor].value === '!') {
    negated = !negated;
    cursor -= 1;
    while (cursor >= conditionStart && tokens[cursor].value === '(') cursor -= 1;
  }
  const isInequality = value => value === '!=' || value === '!==';
  const scanForInequality = (start, step) => {
    for (let index = start; index >= conditionStart && index < tokens.length; index += step) {
      if (isInequality(tokens[index].value)) return true;
      if (['&&', '||', '?', ':', ')'].includes(tokens[index].value)) break;
    }
    return false;
  };
  const isNegatedBooleanComparison = index => {
    const operator = tokens[index]?.value;
    const left = tokens[index - 1]?.value;
    const right = tokens[index + 1]?.value;
    const equalityToFalse = (operator === '==' || operator === '===')
      && (left === 'false' || right === 'false');
    const inequalityFromTrue = (operator === '!=' || operator === '!==')
      && (left === 'true' || right === 'true');
    return equalityToFalse || inequalityFromTrue;
  };
  const scanForNegatedBooleanComparison = (start, step) => {
    for (let index = start; index >= conditionStart && index < tokens.length; index += step) {
      if (isNegatedBooleanComparison(index)) return true;
      if (['&&', '||', '?', ':', ')'].includes(tokens[index].value)) break;
    }
    return false;
  };
  return negated
    || scanForInequality(triggerIndex - 1, -1)
    || scanForInequality(triggerIndex + 1, 1)
    || scanForNegatedBooleanComparison(triggerIndex - 1, -1)
    || scanForNegatedBooleanComparison(triggerIndex + 1, 1);
};

const branchRange = (tokens, start, end, pairs) => {
  if (start >= end) return { start, end, opening: null };
  if (tokens[start].value !== '{') return { start, end, opening: null };
  const closing = pairs.get(start);
  if (closing === undefined || closing >= end) return { start: start + 1, end, opening: start };
  return { start: start + 1, end: closing, opening: start };
};

const findConditionalExpressionDecision = (tokens, triggerIndex, start, end, pairs) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let questionIndex;
  for (let index = triggerIndex + 1; index < end; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (value === '?' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex === undefined) return null;
  let nestedQuestions = 0;
  let colonIndex;
  parenDepth = 0;
  braceDepth = 0;
  bracketDepth = 0;
  for (let index = questionIndex + 1; index < end; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && value === '?') nestedQuestions += 1;
    else if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && value === ':') {
      if (nestedQuestions === 0) {
        colonIndex = index;
        break;
      }
      nestedQuestions -= 1;
    }
  }
  if (colonIndex === undefined) return null;
  const negated = isNegatedDeadlineCondition(tokens, start, triggerIndex);
  const selectedStart = negated ? colonIndex + 1 : questionIndex + 1;
  const selectedEnd = negated ? end : colonIndex;
  return { ...branchRange(tokens, selectedStart, selectedEnd, pairs), opening: null };
};

const findShortCircuitDecision = (tokens, triggerIndex, start, end, pairs) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const conditionStart = ['return', 'throw'].includes(tokens[start]?.value) ? start + 1 : start;
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0
      && index > triggerIndex && (value === '&&' || value === '||')) {
      const negated = isNegatedDeadlineCondition(tokens, conditionStart, triggerIndex);
      const expirySelectsRight = value === '&&' ? !negated : negated;
      if (expirySelectsRight) return branchRange(tokens, index + 1, end, pairs);
    }
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
  }
  return null;
};

const isDirectSwitchAbruptCompletion = (tokens, index, start, pairs) => {
  if (index === start || [';', ':', '}'].includes(tokens[index - 1]?.value)) return true;
  if (tokens[index - 1]?.value !== ')') return false;
  const opening = pairs.get(index - 1);
  return !['if', 'for', 'while', 'switch', 'with', 'catch'].includes(tokens[opening - 1]?.value);
};

const switchArmHasAbruptCompletion = (tokens, start, end, pairs, functionRanges) => {
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  const controlledBlocks = [];
  for (let index = start; index < end; index += 1) {
    const functionRange = functionRanges.find(range => range.opening === index);
    if (functionRange) {
      index = functionRange.closing;
      continue;
    }
    const value = tokens[index].value;
    if (braceDepth <= 1 && !controlledBlocks.includes(true) && parenDepth === 0 && bracketDepth === 0
      && ['break', 'continue', 'return', 'throw'].includes(value)
      && isDirectSwitchAbruptCompletion(tokens, index, start, pairs)) return true;
    if (value === '{') {
      let isControlled = ['else', 'do'].includes(tokens[index - 1]?.value);
      if (tokens[index - 1]?.value === ')') {
        const headerOpening = pairs.get(index - 1);
        isControlled = ['if', 'for', 'while', 'switch', 'catch', 'with'].includes(tokens[headerOpening - 1]?.value);
      }
      controlledBlocks.push(isControlled);
      braceDepth += 1;
    } else if (value === '}') {
      braceDepth -= 1;
      controlledBlocks.pop();
    }
    else if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
  }
  return false;
};

const findSwitchDecision = (tokens, triggerIndex, pairs, functionRanges) => {
  let best = null;
  for (let index = triggerIndex - 1; index >= 0; index -= 1) {
    if (tokens[index].value !== 'switch' || tokens[index + 1]?.value !== '(') continue;
    const conditionEnd = pairs.get(index + 1);
    const opening = conditionEnd === undefined ? undefined : conditionEnd + 1;
    const closing = opening === undefined ? undefined : pairs.get(opening);
    if (opening === undefined || tokens[opening]?.value !== '{' || closing === undefined
      || triggerIndex <= opening || triggerIndex >= closing) continue;
    if (!best || closing - opening < best.closing - best.opening) best = { opening, closing };
  }
  if (!best) return null;
  const labels = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = best.opening + 1; index < best.closing; index += 1) {
    const value = tokens[index].value;
    if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && (value === 'case' || value === 'default')) {
      let colon = index + 1;
      while (colon < best.closing && tokens[colon].value !== ':') colon += 1;
      labels.push({ index, start: Math.min(colon + 1, best.closing) });
      index = colon;
    }
  }
  const matchingLabels = labels.filter(candidate => candidate.index <= triggerIndex);
  const label = matchingLabels[matchingLabels.length - 1];
  if (!label) return null;
  let bodyPosition = labels.indexOf(label);
  while (bodyPosition + 1 < labels.length && labels[bodyPosition].start === labels[bodyPosition + 1].index) {
    bodyPosition += 1;
  }
  const start = labels[bodyPosition].start;
  let end = best.closing;
  for (let index = bodyPosition; index < labels.length; index += 1) {
    const next = labels[index + 1];
    const armEnd = next?.index ?? best.closing;
    if (switchArmHasAbruptCompletion(tokens, labels[index].start, armEnd, pairs, functionRanges)) {
      end = armEnd;
      break;
    }
  }
  return { start, end, opening: best.opening };
};

const extractDeadlineDecision = (tokens, triggerIndex, pairs, functionRanges) => {
  const ifDecision = findIfDecision(tokens, triggerIndex, pairs);
  if (ifDecision) {
    const conditionStart = ifDecision.start + 2;
    const consequentStart = ifDecision.closingCondition + 1;
    const consequentEnd = findControlledStatementEnd(tokens, consequentStart, tokens.length, pairs, false);
    const alternateStart = tokens[consequentEnd]?.value === 'else' ? consequentEnd + 1 : consequentEnd;
    const negated = isNegatedDeadlineCondition(tokens, conditionStart, triggerIndex);
    if (negated && alternateStart === consequentEnd) {
      const fallthroughEnd = findControlledStatementEnd(tokens, consequentEnd, tokens.length, pairs);
      return branchRange(tokens, consequentEnd, fallthroughEnd, pairs);
    }
    return branchRange(
      tokens,
      negated ? alternateStart : consequentStart,
      negated ? findControlledStatementEnd(tokens, alternateStart, tokens.length, pairs) : consequentEnd,
      pairs
    );
  }
  const switchDecision = findSwitchDecision(tokens, triggerIndex, pairs, functionRanges);
  if (switchDecision) return switchDecision;
  const statement = findStatementRange(tokens, triggerIndex);
  const shortCircuit = findShortCircuitDecision(tokens, triggerIndex, statement.start, statement.end, pairs);
  if (shortCircuit) return shortCircuit;
  const functionDecision = findFunctionDecision(functionRanges, triggerIndex);
  if (functionDecision) {
    if (functionDecision.expression) {
      return findConditionalExpressionDecision(
        tokens,
        triggerIndex,
        functionDecision.bodyStart,
        functionDecision.bodyEnd,
        pairs
      ) || { start: functionDecision.bodyStart, end: functionDecision.bodyEnd, opening: null };
    }
    const conditional = findConditionalExpressionDecision(tokens, triggerIndex, statement.start, statement.end, pairs);
    if (conditional) return conditional;
    if (triggerIndex < functionDecision.opening) {
      return { start: functionDecision.opening, end: functionDecision.opening, opening: null };
    }
    return { start: functionDecision.opening + 1, end: functionDecision.closing, opening: functionDecision.opening };
  }
  return findConditionalExpressionDecision(tokens, triggerIndex, statement.start, statement.end, pairs) || statement;
};

const BOUNDARY_WRITER_STATE_ARGUMENTS = new Map([
  ['boundary', 0],
  ['markIntakeBoundary', 1],
  ['markThreadBoundary', 1],
  ['recordBoundary', 2],
  ['recordOwnedBoundary', 2]
]);

const isBoundaryWriter = value => BOUNDARY_WRITER_STATE_ARGUMENTS.has(value);

const boundaryWriterStateArgument = value => BOUNDARY_WRITER_STATE_ARGUMENTS.get(value);

const boundaryWriterCallOpening = (tokens, index) => {
  if (tokens[index + 1]?.value === '(') return index + 1;
  if (tokens[index + 1]?.value === '?.' && tokens[index + 2]?.value === '(') return index + 2;
  return null;
};

const trimExpressionRange = (tokens, start, end, pairs) => {
  while (start < end && tokens[end - 1]?.value === ';') end -= 1;
  while (start < end && tokens[start]?.value === '(' && pairs.get(start) === end - 1) {
    start += 1;
    end -= 1;
  }
  return { start, end };
};

const isReadinessVocabulary = value => value === 'READINESS'
  || value === 'THREAD_STATES'
  || /(?:^|_)READINESS$/.test(value)
  || /Readiness$/.test(value);

const isGapMemberExpression = (tokens, start, end) => end - start === 3
  && tokens[start]?.type === 'identifier'
  && isReadinessVocabulary(tokens[start].value)
  && tokens[start + 1]?.value === '.'
  && tokens[start + 2]?.value === 'GAP';

const destructuredValueHasGapOutcome = (tokens, start, end, propertyPath, pairs) => {
  if (propertyPath?.length !== 1 || propertyPath[0] !== 'GAP') return false;
  const expression = trimExpressionRange(tokens, start, end, pairs);
  return expression.end - expression.start === 1
    && tokens[expression.start]?.type === 'identifier'
    && isReadinessVocabulary(tokens[expression.start].value);
};

const valueHasGapOutcome = (tokens, start, end, pairs, aliases = new Set()) => {
  const expression = trimExpressionRange(tokens, start, end, pairs);
  if (expression.start >= expression.end) return false;
  if (expression.end - expression.start === 1 && aliases.has(tokens[expression.start].value)) return true;
  if (isGapMemberExpression(tokens, expression.start, expression.end)) return true;
  if (valueHasGap(tokens, expression.start, expression.end, pairs, aliases)) return true;

  const wrapperStart = expression.start;
  const wrapperOpening = wrapperStart + 3;
  if (tokens[wrapperStart]?.value !== 'Promise'
    || tokens[wrapperStart + 1]?.value !== '.'
    || tokens[wrapperStart + 2]?.value !== 'resolve'
    || tokens[wrapperOpening]?.value !== '(') return false;
  const wrapperClosing = pairs.get(wrapperOpening);
  if (wrapperClosing !== expression.end - 1) return false;
  return valueHasGapOutcome(tokens, wrapperOpening + 1, wrapperClosing, pairs, aliases);
};

const outcomeAssignmentValueStart = (tokens, index) => {
  if (tokens[index]?.type !== 'identifier' || tokens[index - 1]?.value === '.') return null;
  if (tokens[index + 1]?.value === '.'
    && OUTCOME_NAMES.has(tokens[index + 2]?.value)
    && tokens[index + 3]?.value === '=') return index + 4;
  if (tokens[index + 1]?.value === '['
    && ['string', 'template'].includes(tokens[index + 2]?.type)
    && OUTCOME_NAMES.has(tokens[index + 2]?.value)
    && tokens[index + 3]?.value === ']'
    && tokens[index + 4]?.value === '=') return index + 5;
  return null;
};

const callHasGapArgument = (tokens, opening, closing, pairs, stateArgument, aliases = new Set()) => {
  if (stateArgument === undefined) return false;
  let argumentStart = opening + 1;
  let argumentIndex = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  const check = argumentEnd => argumentIndex === stateArgument
    && valueHasGapOutcome(tokens, argumentStart, argumentEnd, pairs, aliases);
  for (let index = opening + 1; index < closing; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (value === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      if (check(index)) return true;
      argumentStart = index + 1;
      argumentIndex += 1;
    }
  }
  return check(closing);
};

const hasBoundaryWriterGap = (tokens, start, end, pairs, functionRanges, aliases) => {
  const nestedFunctionStarts = new Map(functionRanges
    .filter(range => range.start >= start && range.opening < end)
    .map(range => [range.start, range]));
  for (let index = start; index < end; index += 1) {
    const nestedFunction = nestedFunctionStarts.get(index);
    if (nestedFunction) {
      if (isImmediatelyInvokedFunction(tokens, pairs, nestedFunction)) {
        const bodyStart = nestedFunction.expression ? nestedFunction.bodyStart : nestedFunction.opening + 1;
        const bodyEnd = nestedFunction.expression ? nestedFunction.bodyEnd : nestedFunction.closing;
        if (hasBoundaryWriterGap(tokens, bodyStart, bodyEnd, pairs, functionRanges, aliases)) return true;
      }
      index = nestedFunction.closing;
      continue;
    }
    if (tokens[index]?.type !== 'identifier' || !isBoundaryWriter(tokens[index].value)) continue;
    if (tokens[index - 1]?.value === 'function') continue;
    const opening = boundaryWriterCallOpening(tokens, index);
    const closing = opening === null ? undefined : pairs.get(opening);
    if (closing !== undefined && closing < end
      && callHasGapArgument(tokens, opening, closing, pairs, boundaryWriterStateArgument(tokens[index].value), aliases)) {
      return true;
    }
  }
  return false;
};

const isImmediatelyInvokedFunction = (tokens, pairs, range) => {
  let next = range.closing + 1;
  while (tokens[next]?.value === ')') {
    const opening = pairs.get(next);
    if (opening === undefined) return false;
    const preceding = tokens[opening - 1];
    if (preceding?.type === 'identifier' || [')', ']', '.', '?.'].includes(preceding?.value)) return false;
    next += 1;
  }
  if (tokens[next]?.value === '?.') next += 1;
  return tokens[next]?.value === '(';
};

const hasGapOutcome = (tokens, start, end, opening, pairs, functionRanges, aliases = new Set()) => {
  const knownAliases = new Set(aliases);
  const nestedFunctionStarts = new Map(functionRanges
    .filter(range => range.opening !== opening && range.start >= start && range.opening < end)
    .map(range => [range.start, range]));
  for (let index = start; index < end; index += 1) {
    const nestedFunction = nestedFunctionStarts.get(index);
    if (nestedFunction) {
      if (isImmediatelyInvokedFunction(tokens, pairs, nestedFunction)) {
        const bodyStart = nestedFunction.expression ? nestedFunction.bodyStart : nestedFunction.opening + 1;
        const bodyEnd = nestedFunction.expression ? nestedFunction.bodyEnd : nestedFunction.closing;
        if (hasGapOutcome(tokens, bodyStart, bodyEnd, nestedFunction.opening, pairs, functionRanges, knownAliases)) return true;
      }
      index = nestedFunction.closing;
      continue;
    }
    const token = tokens[index];
    if (token.value === 'return') {
      const statementEnd = findStatementEnd(tokens, index + 1, end);
      const expressionStart = index + 1;
      if (valueHasGapOutcome(tokens, expressionStart, statementEnd, pairs, knownAliases)) return true;
      if (hasBoundaryWriterGap(tokens, expressionStart, statementEnd, pairs, functionRanges, knownAliases)) return true;
      index = Math.max(index, statementEnd - 1);
      continue;
    }
    const assignmentValueStart = outcomeAssignmentValueStart(tokens, index);
    if (assignmentValueStart !== null) {
      const statementEnd = findStatementEnd(tokens, assignmentValueStart, end);
      if (valueHasGapOutcome(tokens, assignmentValueStart, statementEnd, pairs, knownAliases)) return true;
      index = Math.max(index, statementEnd - 1);
      continue;
    }
    if (token.type === 'identifier' && tokens[index - 1]?.value !== '.'
      && tokens[index + 1]?.value === '=') {
      const statementEnd = findStatementEnd(tokens, index + 2, end);
      const assignedGap = valueHasGapOutcome(tokens, index + 2, statementEnd, pairs, knownAliases);
      if (assignedGap) knownAliases.add(token.value);
      if (assignedGap && OUTCOME_NAMES.has(token.value)) return true;
      index = Math.max(index, statementEnd - 1);
      continue;
    }
    if (token.type === 'identifier' && isBoundaryWriter(token.value)
      && tokens[index - 1]?.value !== 'function') {
      const opening = boundaryWriterCallOpening(tokens, index);
      const closing = opening === null ? undefined : pairs.get(opening);
      if (closing !== undefined && closing < end
        && callHasGapArgument(tokens, opening, closing, pairs, boundaryWriterStateArgument(token.value), knownAliases)) return true;
    }
  }
  return opening === null && valueHasGapOutcome(tokens, start, end, pairs, knownAliases);
};

const isDeadlineTriggerAt = (tokens, index) => {
  const value = tokens[index]?.value;
  if (value === 'deadlineReached') return true;
  if (value === 'DEADLINE') {
    let memberStart = index;
    while (tokens[memberStart - 1]?.value === '.' && tokens[memberStart - 2]?.type === 'identifier') {
      memberStart -= 2;
    }
    let memberEnd = index + 1;
    while (tokens[memberEnd]?.value === '.' && tokens[memberEnd + 1]?.type === 'identifier') memberEnd += 2;
    return COMPARISON_OPERATORS.has(tokens[memberStart - 1]?.value)
      || COMPARISON_OPERATORS.has(tokens[memberEnd]?.value)
      || tokens[memberStart - 1]?.value === 'case';
  }
  const deadlineOperandEnd = start => {
    if (tokens[start]?.type !== 'identifier') return null;
    let end = start + 1;
    while (['.', '?.'].includes(tokens[end]?.value) && tokens[end + 1]?.type === 'identifier') end += 2;
    return /deadline/i.test(tokens[end - 1]?.value) ? end : null;
  };
  const dateNow = offset => tokens[index + offset]?.value === 'Date'
    && tokens[index + offset + 1]?.value === '.'
    && tokens[index + offset + 2]?.value === 'now'
    && tokens[index + offset + 3]?.value === '('
    && tokens[index + offset + 4]?.value === ')';
  const directComparison = dateNow(0)
    && ['>', '>='].includes(tokens[index + 5]?.value)
    && deadlineOperandEnd(index + 6) !== null;
  const reverseOperandEnd = deadlineOperandEnd(index);
  const reverseComparison = reverseOperandEnd !== null
    && ['<', '<='].includes(tokens[reverseOperandEnd]?.value)
    && dateNow(reverseOperandEnd + 1 - index);
  return directComparison || reverseComparison;
};

const findAssignedAlias = (tokens, triggerIndex) => {
  if (tokens[triggerIndex - 1]?.value === '=>' || tokens[triggerIndex + 1]?.value === '=>') return null;
  let statementStart = triggerIndex;
  while (statementStart > 0 && ![';', '{', '}'].includes(tokens[statementStart - 1].value)) statementStart -= 1;
  const statementEnd = findStatementEnd(tokens, statementStart, tokens.length);
  const declarationIndex = tokens
    .slice(statementStart, triggerIndex)
    .findIndex(token => ['const', 'let', 'var'].includes(token.value));
  if (declarationIndex >= 0) {
    const declarationStart = statementStart + declarationIndex + 1;
    const declarationSegments = topLevelSegments(tokens, declarationStart, statementEnd);
    const containingSegment = declarationSegments.find(([start, end]) => triggerIndex >= start && triggerIndex < end);
    if (containingSegment) {
      const equalsIndex = topLevelToken(tokens, containingSegment[0], containingSegment[1], '=');
      if (equalsIndex > containingSegment[0]
        && tokens[equalsIndex - 1]?.type === 'identifier'
        && tokens[equalsIndex - 2]?.value !== '.') {
        return { name: tokens[equalsIndex - 1].value, index: equalsIndex - 1 };
      }
    }
  }
  let assignedAlias = null;
  for (let index = statementStart; index < triggerIndex; index += 1) {
    if (tokens[index].value === '=>') return null;
    if (tokens[index].value !== '=' || tokens[index - 1]?.type !== 'identifier' || tokens[index - 2]?.value === '.') continue;
    assignedAlias = { name: tokens[index - 1].value, index: index - 1 };
  }
  return assignedAlias;
};

const findIdentifierAssignments = (tokens, lexicalScopes) => tokens.flatMap((token, index) => {
  if (token.value !== '=' || tokens[index - 1]?.type !== 'identifier' || tokens[index - 2]?.value === '.') {
    return [];
  }
  return [{
    name: tokens[index - 1].value,
    index: index - 1,
    equalsIndex: index,
    scope: lexicalScopePath(lexicalScopes, index - 1)
  }];
});

const findAssignmentValueEnd = (tokens, start, end) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0
      && (value === ',' || value === ';')) return index;
  }
  return end;
};

const resolveVisibleAssignment = (assignments, name, index, lexicalScopes, bindingIndex) => assignments
  .filter(assignment => assignment.name === name
    && assignment.index < index
    && assignment.bindingIndex === bindingIndex
    && isLexicallyVisible(assignment.scope, lexicalScopePath(lexicalScopes, index)))
  .sort((left, right) => right.index - left.index)[0];

const findLexicalScopes = (tokens, pairs) => tokens.flatMap((token, opening) => {
  if (token.value !== '{') return [];
  const closing = pairs.get(opening);
  return closing === undefined ? [] : [{ opening, closing }];
});

const lexicalScopePath = (scopes, index) => scopes
  .filter(scope => scope.opening < index && index < scope.closing)
  .sort((left, right) => left.opening - right.opening)
  .map(scope => scope.opening);

const isLexicallyVisible = (declarationScope, useScope) => declarationScope.every(
  (scope, index) => useScope[index] === scope
);

const findDeclarationEquals = (tokens, start, end) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && value === '=') return index;
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && value === ';') return -1;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
  }
  return -1;
};

const findVariableDeclarations = (tokens, pairs, lexicalScopes, functionRanges = []) => {
  const declarations = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!['const', 'let', 'var'].includes(tokens[index].value)) continue;
    const declarationEnd = findStatementEnd(tokens, index + 1, tokens.length);
    const functionScope = functionRanges
      .filter(range => !range.expression && range.opening < index && index < range.closing)
      .sort((left, right) => (left.closing - left.opening) - (right.closing - right.opening))[0];
    for (const [segmentStart, segmentEnd] of topLevelSegments(tokens, index + 1, declarationEnd)) {
      const equalsIndex = topLevelToken(tokens, segmentStart, segmentEnd, '=');
      if (equalsIndex < 0) continue;
      const bindingIndexes = parameterBindingIndexes(tokens, pairs, segmentStart, equalsIndex);
      for (const binding of bindingIndexes) {
        const nameIndex = binding.index;
        if (tokens[nameIndex]?.type !== 'identifier') continue;
        declarations.push({
          name: tokens[nameIndex].value,
          index: nameIndex,
          propertyPath: binding.propertyPath,
          scope: tokens[index].value === 'var' && functionScope
            ? lexicalScopePath(lexicalScopes, functionScope.opening + 1)
            : lexicalScopePath(lexicalScopes, index),
          expressionStart: equalsIndex + 1,
          expressionEnd: segmentEnd
        });
      }
    }
  }
  return declarations;
};

const topLevelToken = (tokens, start, end, target) => {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && value === target) return index;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
  }
  return -1;
};

const topLevelSegments = (tokens, start, end) => {
  const segments = [];
  let segmentStart = start;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < end; index += 1) {
    const value = tokens[index].value;
    if (value === '(') parenDepth += 1;
    else if (value === ')') parenDepth -= 1;
    else if (value === '{') braceDepth += 1;
    else if (value === '}') braceDepth -= 1;
    else if (value === '[') bracketDepth += 1;
    else if (value === ']') bracketDepth -= 1;
    else if (value === ',' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
      segments.push([segmentStart, index]);
      segmentStart = index + 1;
    }
  }
  segments.push([segmentStart, end]);
  return segments;
};

const parameterBindingIndexes = (tokens, pairs, start, end) => {
  while (start < end && tokens[start].value === '...') start += 1;
  const equalsIndex = topLevelToken(tokens, start, end, '=');
  if (equalsIndex >= 0) end = equalsIndex;
  if (start >= end) return [];
  if (tokens[start].value === '{' || tokens[start].value === '[') {
    const objectPattern = tokens[start].value === '{';
    const closing = pairs.get(start);
    const patternEnd = closing !== undefined && closing < end ? closing : end;
    return topLevelSegments(tokens, start + 1, patternEnd).flatMap(([segmentStart, segmentEnd]) => {
      const rest = tokens[segmentStart]?.value === '...';
      while (segmentStart < segmentEnd && tokens[segmentStart].value === '...') segmentStart += 1;
      const colonIndex = topLevelToken(tokens, segmentStart, segmentEnd, ':');
      const propertyPath = objectPattern && !rest ? [tokens[segmentStart]?.value] : [];
      return parameterBindingIndexes(
        tokens,
        pairs,
        colonIndex >= 0 ? colonIndex + 1 : segmentStart,
        segmentEnd
      ).map(binding => ({
        ...binding,
        propertyPath: [...propertyPath, ...(binding.propertyPath || [])]
      }));
    });
  }
  return tokens[start].type === 'identifier'
    ? [{ name: tokens[start].value, index: start, propertyPath: [] }]
    : [];
};

const findFunctionParameterBindings = (tokens, pairs, lexicalScopes, functionRanges) => functionRanges.flatMap(range => {
  const scope = lexicalScopePath(lexicalScopes, range.opening + 1);
  if (tokens[range.start]?.value === '=>') {
    const previousIndex = range.start - 1;
    if (tokens[previousIndex]?.type === 'identifier') {
      return [{ name: tokens[previousIndex].value, index: previousIndex, scope }];
    }
    if (tokens[previousIndex]?.value === ')') {
      const parameterOpening = pairs.get(previousIndex);
      if (parameterOpening !== undefined) {
        return parameterBindingIndexes(tokens, pairs, parameterOpening + 1, previousIndex)
          .map(binding => ({ ...binding, scope }));
      }
    }
    return [];
  }
  const parameterClosing = range.opening - 1;
  const parameterOpening = tokens[parameterClosing]?.value === ')' ? pairs.get(parameterClosing) : undefined;
  if (parameterOpening === undefined || parameterClosing >= range.opening) return [];
  return topLevelSegments(tokens, parameterOpening + 1, parameterClosing).flatMap(([start, end]) => (
    parameterBindingIndexes(tokens, pairs, start, end).map(binding => ({ ...binding, scope }))
  ));
});

const findCatchBindings = (tokens, pairs, lexicalScopes) => {
  const bindings = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== 'catch' || tokens[index + 1]?.value !== '(') continue;
    const parameterClosing = pairs.get(index + 1);
    const bodyOpening = parameterClosing === undefined ? undefined : parameterClosing + 1;
    if (bodyOpening === undefined || tokens[bodyOpening]?.value !== '{') continue;
    const scope = lexicalScopePath(lexicalScopes, bodyOpening + 1);
    for (const binding of parameterBindingIndexes(tokens, pairs, index + 2, parameterClosing)) {
      bindings.push({ ...binding, scope });
    }
  }
  return bindings;
};

const collectLexicalBindings = (tokens, pairs, lexicalScopes, functionRanges) => [
  ...findVariableDeclarations(tokens, pairs, lexicalScopes, functionRanges),
  ...findFunctionParameterBindings(tokens, pairs, lexicalScopes, functionRanges),
  ...findCatchBindings(tokens, pairs, lexicalScopes)
];

const resolveVisibleBinding = (bindings, name, useIndex, lexicalScopes, useScope = null) => {
  const scope = useScope || lexicalScopePath(lexicalScopes, useIndex);
  const candidates = bindings
    .filter(binding => binding.name === name
      && binding.index < useIndex
      && isLexicallyVisible(binding.scope, scope))
    .sort((left, right) => left.scope.length - right.scope.length || left.index - right.index);
  return candidates[candidates.length - 1] || null;
};

const visibleGapAliasesAt = (tokens, limit, pairs, lexicalScopes, functionRanges, baseAliases = new Set()) => {
  const declarations = findVariableDeclarations(tokens, pairs, lexicalScopes, functionRanges)
    .filter(declaration => declaration.index < limit)
    .sort((left, right) => left.index - right.index);
  const bindings = collectLexicalBindings(tokens, pairs, lexicalScopes, functionRanges);
  const useScope = lexicalScopePath(lexicalScopes, limit);
  const knownAliases = new Set(baseAliases);
  const assignments = findIdentifierAssignments(tokens, lexicalScopes)
    .filter(assignment => assignment.index < limit)
    .map(assignment => {
      const binding = resolveVisibleBinding(
        bindings,
        assignment.name,
        assignment.index + 1,
        lexicalScopes
      );
      const bindingAtUse = resolveVisibleBinding(
        bindings,
        assignment.name,
        limit,
        lexicalScopes,
        useScope
      );
      if (!binding || !bindingAtUse || binding.index !== bindingAtUse.index
        || !isLexicallyVisible(binding.scope, useScope)) return null;
      return {
        ...assignment,
        bindingIndex: binding.index,
        expressionStart: assignment.equalsIndex + 1,
        expressionEnd: findAssignmentValueEnd(tokens, assignment.equalsIndex + 1, tokens.length)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index);
  const simpleAssignmentIndexes = new Set(assignments.map(assignment => assignment.index));
  for (const declaration of declarations) {
    if (!isLexicallyVisible(declaration.scope, useScope)) continue;
    const visibleBinding = resolveVisibleBinding(
      bindings,
      declaration.name,
      limit,
      lexicalScopes,
      useScope
    );
    if (!visibleBinding || visibleBinding.index !== declaration.index) continue;
    if (simpleAssignmentIndexes.has(declaration.index)) continue;
    const assignedGap = declaration.propertyPath?.length
      ? destructuredValueHasGapOutcome(
        tokens,
        declaration.expressionStart,
        declaration.expressionEnd,
        declaration.propertyPath,
        pairs
      )
      : valueHasGapOutcome(
        tokens,
        declaration.expressionStart,
        declaration.expressionEnd,
        pairs,
        knownAliases
      );
    if (assignedGap) knownAliases.add(declaration.name);
    else knownAliases.delete(declaration.name);
  }
  for (const assignment of assignments) {
    const assignedGap = valueHasGapOutcome(
      tokens,
      assignment.expressionStart,
      assignment.expressionEnd,
      pairs,
      knownAliases
    );
    if (assignedGap) knownAliases.add(assignment.name);
    else knownAliases.delete(assignment.name);
  }
  return knownAliases;
};

const isConditionalDeadlineUse = (tokens, triggerIndex, pairs, functionRanges) => {
  if (findIfDecision(tokens, triggerIndex, pairs)
    || findSwitchDecision(tokens, triggerIndex, pairs, functionRanges)) return true;
  const statement = findStatementRange(tokens, triggerIndex);
  if (findShortCircuitDecision(tokens, triggerIndex, statement.start, statement.end, pairs)) return true;
  const functionDecision = findFunctionDecision(functionRanges, triggerIndex);
  if (functionDecision?.expression) {
    return Boolean(findConditionalExpressionDecision(
      tokens,
      triggerIndex,
      functionDecision.bodyStart,
      functionDecision.bodyEnd,
      pairs
    ));
  }
  return Boolean(findConditionalExpressionDecision(tokens, triggerIndex, statement.start, statement.end, pairs));
};

const findDeadlineGapOffenders = entries => entries.flatMap(({ relative, source }) => {
  const tokens = tokenizeSource(source);
  const pairs = findTokenPairs(tokens);
  const functionRanges = findFunctionRanges(tokens, pairs);
  const lexicalScopes = findLexicalScopes(tokens, pairs);
  const lexicalBindings = collectLexicalBindings(tokens, pairs, lexicalScopes, functionRanges);
  const assignments = findIdentifierAssignments(tokens, lexicalScopes).map(assignment => {
    const binding = resolveVisibleBinding(
      lexicalBindings,
      assignment.name,
      assignment.index + 1,
      lexicalScopes
    );
    return {
      ...assignment,
      bindingIndex: binding?.index,
      scope: binding?.scope || assignment.scope
    };
  });
  const lines = new Set();
  const deadlineAliases = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isDeadlineTriggerAt(tokens, index)) continue;
    const alias = findAssignedAlias(tokens, index);
    if (alias) {
      deadlineAliases.push({
        ...alias,
        bindingIndex: resolveVisibleBinding(
          lexicalBindings,
          alias.name,
          alias.index + 1,
          lexicalScopes
        )?.index,
        scope: lexicalScopePath(lexicalScopes, alias.index)
      });
      if (isConditionalDeadlineUse(tokens, index, pairs, functionRanges)) {
        const decision = extractDeadlineDecision(tokens, index, pairs, functionRanges);
        const knownAliases = visibleGapAliasesAt(
          tokens,
          decision.start,
          pairs,
          lexicalScopes,
          functionRanges
        );
        if (hasGapOutcome(
          tokens,
          decision.start,
          decision.end,
          decision.opening,
          pairs,
          functionRanges,
          knownAliases
        )) {
          lines.add(source.slice(0, tokens[index].start).split(/\r?\n/).length);
        }
      }
      continue;
    }
    if (!isConditionalDeadlineUse(tokens, index, pairs, functionRanges)) continue;
    const decision = extractDeadlineDecision(tokens, index, pairs, functionRanges);
    const knownAliases = visibleGapAliasesAt(
      tokens,
      decision.start,
      pairs,
      lexicalScopes,
      functionRanges
    );
    if (hasGapOutcome(
      tokens,
      decision.start,
      decision.end,
      decision.opening,
      pairs,
      functionRanges,
      knownAliases
    )) {
      lines.add(source.slice(0, tokens[index].start).split(/\r?\n/).length);
    }
  }
  let aliasesAdded = true;
  while (aliasesAdded) {
    aliasesAdded = false;
    for (const assignment of assignments) {
      if (assignment.bindingIndex === undefined
        || deadlineAliases.some(alias => alias.index === assignment.index
          && alias.bindingIndex === assignment.bindingIndex)) continue;
      const valueEnd = findAssignmentValueEnd(tokens, assignment.equalsIndex + 1, tokens.length);
      const valueRange = trimExpressionRange(tokens, assignment.equalsIndex + 1, valueEnd, pairs);
      if (valueRange.end - valueRange.start !== 1) continue;
      const sourceToken = tokens[valueRange.start];
      if (sourceToken?.type !== 'identifier') continue;
      const sourceBinding = resolveVisibleBinding(
        lexicalBindings,
        sourceToken.value,
        valueRange.start,
        lexicalScopes
      );
      if (!sourceBinding) continue;
      const sourceAlias = deadlineAliases.find(alias => alias.name === sourceToken.value
        && alias.bindingIndex === sourceBinding.index
        && alias.index < valueRange.start);
      if (!sourceAlias) continue;
      const latestSourceAssignment = resolveVisibleAssignment(
        assignments,
        sourceAlias.name,
        valueRange.start,
        lexicalScopes,
        sourceBinding.index
      );
      if (latestSourceAssignment?.index !== sourceAlias.index) continue;
      deadlineAliases.push({
        name: assignment.name,
        index: assignment.index,
        bindingIndex: assignment.bindingIndex,
        scope: assignment.scope
      });
      aliasesAdded = true;
    }
  }
  for (const alias of deadlineAliases) {
    for (let index = 0; index < tokens.length; index += 1) {
      if (index === alias.index || tokens[index].value !== alias.name || tokens[index - 1]?.value === '.') continue;
      if (lexicalBindings.some(binding => binding.name === alias.name && binding.index === index)) continue;
      const binding = resolveVisibleBinding(lexicalBindings, alias.name, index, lexicalScopes);
      if (!binding || binding.index !== alias.bindingIndex) continue;
      const assignment = resolveVisibleAssignment(
        assignments,
        alias.name,
        index,
        lexicalScopes,
        binding.index
      );
      if (!assignment || assignment.index !== alias.index) continue;
      if (!isConditionalDeadlineUse(tokens, index, pairs, functionRanges)) continue;
      const decision = extractDeadlineDecision(tokens, index, pairs, functionRanges);
      const knownAliases = visibleGapAliasesAt(
        tokens,
        decision.start,
        pairs,
        lexicalScopes,
        functionRanges
      );
      if (hasGapOutcome(
        tokens,
        decision.start,
        decision.end,
        decision.opening,
        pairs,
        functionRanges,
        knownAliases
      )) {
        lines.add(source.slice(0, tokens[index].start).split(/\r?\n/).length);
      }
    }
  }
  return [...lines].sort((left, right) => left - right).map(line => `${relative}:${line}`);
});

test('deadline policy inventory has no direct deadline-to-gap decision', () => {
  const sourceRoot = path.join(__dirname, '../../src');
  const offenders = findDeadlineGapOffenders(readSourceInventory(sourceRoot));
  assert.deepEqual(offenders, [], 'new deadline decisions must not map expiry directly to a history gap');
});

test('deadline policy inventory maps local boundary state arguments', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/thread-enrollment.ts',
    source: [
      'function boundary(state, detail, source) { persist(state, detail, source); }',
      'if (deadlineReached) boundary(THREAD_STATES.GAP, detail, source);'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/thread-enrollment.ts:2']);
});

test('deadline policy inventory recognizes optional boundary writer calls', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/optional-boundary-writer.js',
    source: 'if (deadlineReached) this.recordBoundary?.(binding, null, READINESS.GAP, detail);'
  }]);
  assert.deepEqual(offenders, ['discord/optional-boundary-writer.js:1']);
});

test('deadline policy inventory ignores non-mutating boundary-shaped calls', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/readiness-predicate.js',
    source: 'if (deadlineReached) { assertReadiness(binding, READINESS.GAP); return READINESS.UNAVAILABLE; }'
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory follows aliases assigned after declaration', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-alias-mutation.js',
    source: [
      'function readiness(deadline) {',
      '  let expired = false;',
      '  expired = Date.now() >= deadline;',
      '  if (expired) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/deadline-alias-mutation.js:4']);
});

test('deadline policy inventory follows chained deadline aliases', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/deadline-alias-chain.js',
    source: [
      'function readiness() {',
      '  const expired = deadlineReached;',
      '  const timedOut = expired;',
      '  if (timedOut) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/deadline-alias-chain.js:4']);
});

test('deadline policy inventory ignores passive deadline metadata and types', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/deadline-metadata.js',
      source: 'const x = { deadlineReached: false, state: READINESS.GAP };'
    },
    {
      relative: 'discord/deadline-metadata.ts',
      source: "type RecoveryMeta = { deadlineReached: boolean; state: 'gap' };"
    }
  ]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory resolves destructured enum values', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-gap-destructured-enum.js',
    source: 'const { GAP: nextState } = READINESS; if (deadlineReached) return nextState;'
  }]);
  assert.deepEqual(offenders, ['deadline-gap-destructured-enum.js:1']);
});

test('deadline policy inventory registers destructured local shadow bindings', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/destructured-shadow.js',
    source: [
      'function readiness(flags) {',
      '  const expired = deadlineReached;',
      '  {',
      '    const { expired } = flags;',
      '    if (expired) return READINESS.GAP;',
      '  }',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline aliases remain shadowed by simple and destructured catch bindings', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'deadline-alias-catch-shadow.js',
      source: 'const expired = deadlineReached; try {} catch (expired) { if (expired) return READINESS.GAP; }'
    },
    {
      relative: 'deadline-alias-catch-destructured-shadow.js',
      source: 'const expired = deadlineReached; try {} catch ({ expired }) { if (expired) return READINESS.GAP; }'
    }
  ]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory ignores gap constants used as predicate inputs', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/readiness-predicate.js',
    source: 'if (deadlineReached) return allowed.includes(READINESS.GAP);'
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory follows inequality polarity', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'strict-inequality.js',
      source: 'if (kind !== CODEX_VALIDATION_KINDS.DEADLINE) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'loose-inequality.js',
      source: 'if (kind != CODEX_VALIDATION_KINDS.DEADLINE) return READINESS.READY; else return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, ['strict-inequality.js:1', 'loose-inequality.js:1']);
});

test('deadline policy inventory follows explicit boolean deadline polarity', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'explicit-false-gap.js',
      source: 'if (deadlineReached === false) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'explicit-false-consequent-gap.js',
      source: 'if (deadlineReached === false) return READINESS.GAP; else return READINESS.READY;'
    },
    {
      relative: 'explicit-true-gap.js',
      source: 'if (deadlineReached !== true) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'explicit-true-consequent-gap.js',
      source: 'if (deadlineReached !== true) return READINESS.GAP; else return READINESS.READY;'
    }
  ]);
  assert.deepEqual(offenders, ['explicit-false-gap.js:1', 'explicit-true-gap.js:1']);
});

test('deadline aliases remain scoped to their lexical declaration', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-scope.js',
    source: [
      'function first() {',
      '  const expired = Date.now() >= deadline;',
      '  if (expired) return READINESS.GAP;',
      '}',
      'function second(expired) {',
      '  if (expired) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['deadline-alias-scope.js:3']);
});

test('deadline policy inventory follows gap aliases declared before the branch', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-gap-alias.js',
    source: [
      'const nextState = READINESS.GAP;',
      'if (deadlineReached) return nextState;'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['deadline-gap-alias.js:2']);
});

test('deadline policy inventory follows gap aliases reassigned before the branch', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-gap-alias-reassignment.js',
    source: [
      'function readiness() {',
      '  let next = READINESS.READY;',
      '  next = READINESS.GAP;',
      '  if (deadlineReached) return next;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['deadline-gap-alias-reassignment.js:4']);
});

test('deadline policy inventory resolves the declarator containing the trigger', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-multi-declarator.js',
    source: [
      'function readiness() {',
      '  const ignored = false, expired = deadlineReached;',
      '  if (expired) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['deadline-multi-declarator.js:3']);
});

test('deadline policy inventory respects nested alias shadowing', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-shadow.js',
    source: [
      'function outer() {',
      '  const expired = Date.now() >= deadline;',
      '  function inner(expired) {',
      '    if (expired) return READINESS.GAP;',
      '  }',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline aliases remain visible across blocks when declared with var', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'deadline-var-alias.js',
      source: [
        'function recover() {',
        '  {',
        '    var expired = deadlineReached;',
        '  }',
        '  if (expired) return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'deadline-var-alias-through-outcome.js',
      source: [
        'function recover() {',
        '  {',
        '    var expired = deadlineReached;',
        '    var nextState = READINESS.GAP;',
        '  }',
        '  if (expired) return nextState;',
        '}'
      ].join('\n')
    }
  ]);
  assert.deepEqual(offenders, [
    'deadline-var-alias.js:5',
    'deadline-var-alias-through-outcome.js:6'
  ]);
});

test('deadline aliases remain shadowed by destructured parameter bindings', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-destructured-parameter.js',
    source: [
      'const expired = deadlineReached;',
      'function nested({ expired } = createDefaults()) {',
      '  if (expired) return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline aliases remain shadowed by concise arrow parameters', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-alias-concise-arrow.js',
    source: [
      'const expired = Date.now() >= deadline;',
      'const choose = expired => expired ? READINESS.GAP : READINESS.READY;'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory ignores gap returns declared in class methods', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'deadline-class-method.js',
    source: [
      'if (deadlineReached) {',
      '  class Policy {',
      '    constructor() { return READINESS.GAP; }',
      '    fallback() { return READINESS.GAP; }',
      '  }',
      '  return READINESS.UNAVAILABLE;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory catches object-shaped gap decisions', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/inbound-recovery.js',
    source: "if (Date.now() >= deadline) return { ready: false, state: 'gap', detail: 'history unavailable' };"
  }]);
  assert.deepEqual(offenders, ['discord/inbound-recovery.js:1']);
});

test('deadline policy inventory recognizes computed gap constants', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/computed-return.js',
      source: "if (deadlineReached) return READINESS['GAP'];"
    },
    {
      relative: 'discord/computed-template-return.js',
      source: 'if (deadlineReached) return THREAD_STATES[`GAP`];'
    },
    {
      relative: 'discord/computed-object-return.js',
      source: "if (deadlineReached) return { state: READINESS['GAP'] };"
    },
    {
      relative: 'discord/computed-writer.js',
      source: "if (deadlineReached) state.markIntakeBoundary(id, READINESS['GAP'], detail);"
    },
    {
      relative: 'discord/computed-template-writer.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(id, THREAD_STATES[`GAP`], detail);'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/computed-return.js:1',
    'discord/computed-template-return.js:1',
    'discord/computed-object-return.js:1',
    'discord/computed-writer.js:1',
    'discord/computed-template-writer.js:1'
  ]);
});

test('deadline policy inventory scans complete outcomes and ignores unrelated gaps', () => {
  const entries = [
    {
      relative: 'discord/multiline-owner.js',
      source: [
        'if (deadlineReached) {',
        '  return {',
        '    ready: false,',
        "    detail: 'expired',",
        "    state: 'gap'",
        '  };',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/multiline-assignment.js',
      source: [
        'const state = deadlineReached',
        '  ? READINESS.GAP',
        '  : READINESS.READY;'
      ].join('\n')
    },
    {
      relative: 'discord/member-assignment.js',
      source: 'if (deadlineReached) result.state = READINESS.GAP;'
    },
    {
      relative: 'discord/computed-member-assignment.js',
      source: "if (deadlineReached) { result['state'] = READINESS.GAP; return result; }"
    },
    {
      relative: 'discord/computed-template-member-assignment.js',
      source: 'if (deadlineReached) { result[`state`] = READINESS.GAP; return result; }'
    },
    {
      relative: 'discord/braced-member-assignment.js',
      source: [
        'if (deadlineReached) {',
        '  result.state = READINESS.GAP;',
        '  return result;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/parenthesized-return.js',
      source: 'if (deadlineReached) return (READINESS.GAP);'
    },
    {
      relative: 'discord/wrapped-return.js',
      source: 'if (deadlineReached) return Promise.resolve(READINESS.GAP);'
    },
    {
      relative: 'discord/parenthesized-object-return.js',
      source: "if (deadlineReached) return ({ state: 'gap' });"
    },
    {
      relative: 'discord/unavailable-owner.js',
      source: [
        'if (deadlineReached) {',
        "  return { ready: false, state: 'unavailable' };",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/reversed-timestamp-deadline.js',
      source: 'if (deadline <= Date.now()) return READINESS.GAP;'
    },
    {
      relative: 'discord/reversed-strict-timestamp-deadline.js',
      source: 'if (deadline < Date.now()) return READINESS.GAP;'
    },
    {
      relative: 'discord/strict-timestamp-deadline.js',
      source: 'if (Date.now() > deadline) return READINESS.GAP;'
    },
    {
      relative: 'discord/retry-owner.js',
      source: [
        'if (deadlineReached) {',
        "  return { ready: false, state: 'retry' };",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/unrelated-gap.js',
      source: [
        'if (deadlineReached) {',
        "  return { ready: false, state: 'retry' };",
        '}',
        "const history = { state: 'gap' };"
      ].join('\n')
    },
    {
      relative: 'discord/nested-gap.js',
      source: [
        'if (deadlineReached) {',
        '  if (shouldRetry) {',
        "    return { state: 'gap' };",
        '  }',
        "  return { state: 'retry' };",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/nested-object-gap.js',
      source: [
        'if (deadlineReached) {',
        "  return { detail: { state: 'gap' } };",
        '}'
      ].join('\n')
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/multiline-owner.js:1',
    'discord/multiline-assignment.js:1',
    'discord/member-assignment.js:1',
    'discord/computed-member-assignment.js:1',
    'discord/computed-template-member-assignment.js:1',
    'discord/braced-member-assignment.js:1',
    'discord/parenthesized-return.js:1',
    'discord/wrapped-return.js:1',
    'discord/parenthesized-object-return.js:1',
    'discord/reversed-timestamp-deadline.js:1',
    'discord/reversed-strict-timestamp-deadline.js:1',
    'discord/strict-timestamp-deadline.js:1',
    'discord/nested-gap.js:1'
  ]);
});

test('deadline policy inventory binds lexical and persistence controls to the deadline branch', () => {
  const entries = [
    {
      relative: 'discord/braceless-gap.js',
      source: [
        'if (deadlineReached) return READINESS.GAP;',
        'function later() { return READINESS.UNAVAILABLE; }'
      ].join('\n')
    },
    {
      relative: 'discord/braceless-safe.js',
      source: [
        'if (deadlineReached) return READINESS.UNAVAILABLE;',
        'function later() { return READINESS.GAP; }'
      ].join('\n')
    },
    {
      relative: 'discord/braceless-safe-asi.js',
      source: [
        'if (deadlineReached) return READINESS.UNAVAILABLE',
        'function later() { return READINESS.GAP; }'
      ].join('\n')
    },
    {
      relative: 'discord/comment-brace.js',
      source: [
        'if (deadlineReached) { // }',
        "  return 'gap';",
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/comment-decoy.js',
      source: [
        "if (deadlineReached) return READINESS.UNAVAILABLE; // state: 'gap'",
        'const regex = /return gap/;'
      ].join('\n')
    },
    {
      relative: 'discord/regex-brace.js',
      source: [
        'if (deadlineReached) {',
        '  const regex = /}/;',
        '  return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/template-return.js',
      source: 'if (deadlineReached) return `gap`;'
    },
    {
      relative: 'discord/template-property.js',
      source: 'if (deadlineReached) return { state: `gap` };'
    },
    {
      relative: 'discord/template-decoy.js',
      source: 'if (deadlineReached) return { detail: `state: gap` };'
    },
    {
      relative: 'discord/persistence-gap.js',
      source: 'if (deadlineReached) state.markIntakeBoundary(id, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/thread-boundary-gap.js',
      source: 'if (deadlineReached) state.markThreadBoundary(id, THREAD_STATES.GAP, detail);'
    },
    {
      relative: 'discord/owned-boundary-gap.js',
      source: 'if (deadlineReached) state.recordBoundary(binding, null, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/owned-boundary-owned-gap.js',
      source: 'if (deadlineReached) state.recordOwnedBoundary(binding, null, READINESS.GAP, detail);'
    },
    {
      relative: 'discord/persistence-safe.js',
      source: "if (deadlineReached) state.markIntakeBoundary(id, READINESS.UNAVAILABLE, 'gap');"
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/braceless-gap.js:1',
    'discord/comment-brace.js:1',
    'discord/regex-brace.js:1',
    'discord/template-return.js:1',
    'discord/template-property.js:1',
    'discord/persistence-gap.js:1',
    'discord/thread-boundary-gap.js:1',
    'discord/owned-boundary-gap.js:1',
    'discord/owned-boundary-owned-gap.js:1'
  ]);
});

test('deadline policy inventory catches new owners while allowing unavailable classifiers and ordinary deadlines', () => {
  const entries = [
    {
      relative: 'discord/new-owner.js',
      source: "const state = deadlineReached ? READINESS.GAP : READINESS.READY;"
    },
    {
      relative: 'discord/decoy-classifier.js',
      source: "function recoveryDeadlineClassifier(deadlineReached) { return deadlineReached ? READINESS.GAP : READINESS.READY; }"
    },
    {
      relative: 'discord/adjacent-classifier-call.js',
      source: "if (deadlineReached) { classifyRecoveryFailure(error); return READINESS.GAP; }"
    },
    {
      relative: 'discord/new-timestamp-owner.js',
      source: "if (Date.now() >= deadline) return READINESS.GAP;"
    },
    {
      relative: 'discord/new-string-timestamp-owner.js',
      source: "if (Date.now() >= deadline) return 'gap';"
    },
    {
      relative: 'discord/recovery-fetch.ts',
      source: "function classifyRecoveryFailure(deadlineReached) { return deadlineReached ? READINESS.UNAVAILABLE : READINESS.READY; }"
    },
    {
      relative: 'discord/ordinary-deadline.js',
      source: "if (deadlineReached) return RETRY;"
    },
    {
      relative: 'discord/ordinary-timestamp.js',
      source: "if (Date.now() >= deadline) return RETRY;"
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/new-owner.js:1',
    'discord/decoy-classifier.js:1',
    'discord/adjacent-classifier-call.js:1',
    'discord/new-timestamp-owner.js:1',
    'discord/new-string-timestamp-owner.js:1'
  ]);
});

test('deadline policy inventory follows aliases and selected control arms', () => {
  const entries = [
    {
      relative: 'discord/parenthesized-object-property.js',
      source: 'if (deadlineReached) return { state: (READINESS.GAP) };'
    },
    {
      relative: 'discord/concise-arrow-gap.js',
      source: 'const decide = deadlineReached => deadlineReached ? READINESS.GAP : READINESS.READY;'
    },
    {
      relative: 'discord/aliased-classifier-gap.js',
      source: 'const nextState = deadlineReached ? READINESS.GAP : READINESS.READY;'
    },
    {
      relative: 'discord/aliased-writer-gap.js',
      source: 'if (deadlineReached) { const nextState = READINESS.GAP; recordBoundary(binding, null, nextState, detail); }'
    },
    {
      relative: 'discord/negated-deadline-gap.js',
      source: 'if (!deadlineReached) return READINESS.READY; else return READINESS.GAP;'
    },
    {
      relative: 'discord/aliased-deadline-gap.js',
      source: 'const expired = Date.now() >= deadline; if (expired) return READINESS.GAP;'
    },
    {
      relative: 'discord/comparison-gap-negative.js',
      source: 'if (deadlineReached) return current === READINESS.GAP ? READINESS.UNAVAILABLE : READINESS.PENDING;'
    },
    {
      relative: 'discord/non-deadline-else-negative.js',
      source: 'if (deadlineReached) return READINESS.UNAVAILABLE; else return READINESS.GAP;'
    },
    {
      relative: 'discord/switch-arm-negative.js',
      source: 'switch (kind) { case DEADLINE: return READINESS.UNAVAILABLE; default: return READINESS.GAP; }'
    },
    {
      relative: 'discord/normal-ternary-negative.js',
      source: 'function decide() { return Date.now() >= deadline ? READINESS.UNAVAILABLE : READINESS.GAP; }'
    },
    {
      relative: 'discord/parameter-ternary-negative.js',
      source: 'function decide(deadlineReached) { return deadlineReached ? READINESS.UNAVAILABLE : READINESS.GAP; }'
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/parenthesized-object-property.js:1',
    'discord/concise-arrow-gap.js:1',
    'discord/aliased-classifier-gap.js:1',
    'discord/aliased-writer-gap.js:1',
    'discord/negated-deadline-gap.js:1',
    'discord/aliased-deadline-gap.js:1'
  ]);
});

test('deadline policy inventory follows switch fall-through after nonempty arms', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/switch-fallthrough-gap.js',
    source: [
      'switch (kind) {',
      '  case CODEX_VALIDATION_KINDS.DEADLINE:',
      '    audit();',
      '  case RETRY:',
      '    return READINESS.GAP;',
      '}'
    ].join('\n')
  }]);
  assert.deepEqual(offenders, ['discord/switch-fallthrough-gap.js:2']);
});

test('deadline policy inventory recognizes member-qualified deadline operands', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/member-qualified-deadline.js',
      source: 'if (Date.now() >= options.deadline) return READINESS.GAP;'
    },
    {
      relative: 'discord/reversed-member-qualified-deadline.js',
      source: 'if (options.deadline <= Date.now()) return READINESS.GAP;'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/member-qualified-deadline.js:1',
    'discord/reversed-member-qualified-deadline.js:1'
  ]);
});

test('deadline policy inventory resolves shorthand outcome properties', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/shorthand-gap-outcome.js',
    source: 'const state = READINESS.GAP; if (deadlineReached) return { state };'
  }]);
  assert.deepEqual(offenders, ['discord/shorthand-gap-outcome.js:1']);
});

test('deadline policy inventory inspects boundary writers in returned expressions', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/returned-boundary-writer.js',
    source: 'if (deadlineReached) return recordBoundary(binding, null, READINESS.GAP, detail);'
  }]);
  assert.deepEqual(offenders, ['discord/returned-boundary-writer.js:1']);
});

test('deadline policy inventory inspects boundary writers in invoked nested functions', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/invoked-boundary-writer.js',
    source: 'if (deadlineReached) { (() => recordBoundary(binding, null, READINESS.GAP, detail))(); }'
  }]);
  assert.deepEqual(offenders, ['discord/invoked-boundary-writer.js:1']);
});

test('deadline policy inventory ignores unrelated enum GAP values', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/layout-gap.js',
    source: 'if (deadlineReached) return LAYOUT.GAP;'
  }]);
  assert.deepEqual(offenders, []);
});

test('gap aliases do not cross a shadowing parameter binding', () => {
  const offenders = findDeadlineGapOffenders([{
    relative: 'discord/parameter-shadowed-gap-alias.js',
    source: 'let next = READINESS.GAP; function audit(next) { if (deadlineReached) return next; }'
  }]);
  assert.deepEqual(offenders, []);
});

test('deadline policy inventory follows expiry after negated no-else guards', () => {
  const entries = [
    {
      relative: 'discord/negated-guard-fallthrough.js',
      source: 'if (!deadlineReached) return READINESS.READY; return READINESS.GAP;'
    },
    {
      relative: 'discord/false-guard-fallthrough.js',
      source: 'if (deadlineReached === false) return READINESS.READY; return READINESS.GAP;'
    },
    {
      relative: 'discord/inequality-guard-fallthrough.js',
      source: 'if (deadlineReached !== DEADLINE) return READINESS.READY; return READINESS.GAP;'
    },
    {
      relative: 'discord/negated-guard-ready-fallthrough.js',
      source: 'if (!deadlineReached) return READINESS.READY; return READINESS.READY;'
    }
  ];
  assert.deepEqual(findDeadlineGapOffenders(entries), [
    'discord/negated-guard-fallthrough.js:1',
    'discord/false-guard-fallthrough.js:1',
    'discord/inequality-guard-fallthrough.js:1'
  ]);
});

test('deadline policy inventory honors abrupt completion in braced switch arms', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/braced-switch-break.js',
      source: [
        'switch (kind) {',
        '  case DEADLINE: { audit(); break; }',
        '  case RETRY: return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/conditional-braced-switch-break.js',
      source: [
        'switch (kind) {',
        '  case DEADLINE: { if (shouldExit) break; }',
        '  case RETRY: return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/nested-conditional-switch-break.js',
      source: [
        'switch (kind) {',
        '  case DEADLINE: { if (shouldExit) { break; } }',
        '  case RETRY: return READINESS.GAP;',
        '}'
      ].join('\n')
    },
    {
      relative: 'discord/nested-function-switch-break.js',
      source: [
        'switch (kind) {',
        '  case DEADLINE: function audit() { break; }',
        '  case RETRY: return READINESS.GAP;',
        '}'
      ].join('\n')
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/conditional-braced-switch-break.js:2',
    'discord/nested-conditional-switch-break.js:2',
    'discord/nested-function-switch-break.js:2'
  ]);
});

test('deadline policy inventory inspects short-circuit expiry branches', () => {
  const offenders = findDeadlineGapOffenders([
    {
      relative: 'discord/and-gap-return.js',
      source: 'function outcome() { return deadlineReached && READINESS.GAP; }'
    },
    {
      relative: 'discord/or-negated-gap-return.js',
      source: 'function outcome() { return !deadlineReached || READINESS.GAP; }'
    },
    {
      relative: 'discord/and-boundary-writer.js',
      source: 'function outcome() { deadlineReached && state.markIntakeBoundary(id, READINESS.GAP, detail); }'
    },
    {
      relative: 'discord/or-negated-boundary-writer.js',
      source: 'function outcome() { !deadlineReached || state.markIntakeBoundary(id, READINESS.GAP, detail); }'
    },
    {
      relative: 'discord/and-negated-gap-control.js',
      source: 'function outcome() { !deadlineReached && READINESS.GAP; }'
    },
    {
      relative: 'discord/or-gap-control.js',
      source: 'function outcome() { deadlineReached || READINESS.GAP; }'
    }
  ]);
  assert.deepEqual(offenders, [
    'discord/and-gap-return.js:1',
    'discord/or-negated-gap-return.js:1',
    'discord/and-boundary-writer.js:1',
    'discord/or-negated-boundary-writer.js:1'
  ]);
});

test('pre-adoption retry classifier sites stay in the audited owners', () => {
  const registered = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).scripts.test.split(/\s+/);
  assert.equal(registered.filter(value => value === 'test/policy/intake-recovery-policy.test.js').length, 1,
    'the focused recovery policy inventory must execute exactly once in npm test');
  const sourceRoot = path.join(__dirname, '../../src');
  const sites = new Map();
  for (const { relative, source } of readSourceInventory(sourceRoot)) {
    const count = source.match(/\bisPreAdoptionRetryableThread\b/g)?.length || 0;
    if (count) sites.set(relative, count);
  }
  assert.deepEqual(Object.fromEntries([...sites].sort(([left], [right]) => left.localeCompare(right))), {
    'discord.js': 9,
    'discord/inbound-recovery.js': 1,
    'discord/lifecycle.js': 1,
    'discord/recovery-fetch.ts': 1,
    'discord/thread-enrollment.ts': 3
  }, 'new retryability consumers must join the class inventory before using this policy');
});
