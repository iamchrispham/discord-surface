const path = require('node:path');
const ts = require('typescript');
const { createPolicyModuleGraph } = require('./policy-module-resolution');
const { borrowedStringInput, createPolicyRegexAnalysis } = require('./policy-regex-analysis');
const { commonJsExportAssignment } = require('./policy-reference-analysis');
const PROJECT_ROOT = path.join(__dirname, '..', '..');

function createSourceFile(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    ts.getScriptKindFromFileName(file));
}

function finiteStringValues(expression, bindings, seen = new Set()) {
  const value = unwrapPolicyExpression(expression);
  if (!value) return null;
  if (ts.isStringLiteralLike(value)) return [value.text];
  if (ts.isArrayLiteralExpression(value)) {
    const values = value.elements.map(element =>
      ts.isStringLiteralLike(element) ? element.text : null);
    return values.every(item => item !== null) ? values : null;
  }
  if (!ts.isIdentifier(value)) return null;
  const declaration = resolveBinding(value, bindings);
  if (!declaration || seen.has(declaration)) return null;
  seen.add(declaration);
  if (ts.isParameter(declaration)) {
    const callback = declaration.parent;
    const arrayCall = callback.parent;
    if ((!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
        callback.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
        callback.parameters[0] !== declaration ||
        !ts.isCallExpression(arrayCall) || arrayCall.arguments[0] !== callback ||
        !ts.isPropertyAccessExpression(arrayCall.expression) ||
        !['every', 'some', 'filter', 'find', 'findIndex', 'forEach', 'map', 'flatMap']
          .includes(arrayCall.expression.name.text)) {
      return null;
    }
    return finiteStringValues(arrayCall.expression.expression, bindings, seen);
  }
  if (!ts.isVariableDeclaration(declaration)) return null;
  if (declaration.initializer) {
    const declarationList = declaration.parent;
    if (ts.isVariableDeclarationList(declarationList) &&
        !(declarationList.flags & ts.NodeFlags.Const)) return null;
    return finiteStringValues(declaration.initializer, bindings, seen);
  }
  const declarationList = declaration.parent;
  const loop = declarationList && ts.isVariableDeclarationList(declarationList)
    ? declarationList.parent
    : null;
  if (loop && ts.isForOfStatement(loop) && loop.initializer === declarationList &&
      (declarationList.flags & ts.NodeFlags.Const)) {
    return finiteStringValues(loop.expression, bindings, seen);
  }
  return null;
}

function isRoomField(node, bindings = null) {
  if (!node) return false;
  let object;
  let keys;
  if (ts.isPropertyAccessExpression(node)) {
    object = node.expression;
    keys = [node.name.text];
  } else if (ts.isElementAccessExpression(node) && node.argumentExpression &&
      (ts.isStringLiteralLike(node.argumentExpression) || ts.isIdentifier(node.argumentExpression))) {
    object = node.expression;
    keys = finiteStringValues(node.argumentExpression,
      bindings || collectBindings(node.getSourceFile()));
  } else {
    return false;
  }
  return Boolean(keys?.some(key => ['guildId', 'channelId'].includes(key)) &&
    ts.isIdentifier(object));
}

function isNamedRoomField(node) {
  if (!isRoomField(node)) return false;
  const object = node.expression;
  return /^(?:room|townHall|townHallRoom)$/i.test(object.text);
}

function callPropertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
      ts.isStringLiteralLike(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function regexInput(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === current &&
        ['test', 'exec'].includes(callPropertyName(parent)) &&
        ts.isCallExpression(parent.parent)) {
      return parent.parent.arguments[0] || null;
    }
    if (ts.isCallExpression(parent) && parent.arguments[0] === current &&
        ['match', 'search'].includes(callPropertyName(parent.expression))) {
      return parent.expression.expression;
    }
    if (ts.isCallExpression(parent)) {
      const input = borrowedStringInput(parent, current, ts);
      if (input) return input;
    }
    if (ts.isCallExpression(parent) && parent.arguments[0] === current &&
        ts.isPropertyAccessExpression(parent.expression) &&
        parent.expression.name.text === 'call' &&
        ['test', 'exec'].includes(callPropertyName(parent.expression.expression))) {
      return parent.arguments[1] || null;
    }
    current = parent;
  }
  if (ts.isRegularExpressionLiteral(node) && ts.isVariableDeclaration(node.parent) &&
      node.parent.initializer === node && ts.isIdentifier(node.parent.name)) {
    const sourceFile = node.getSourceFile();
    const declaration = node.parent;
    const bindings = collectBindings(sourceFile);
    const binding = bindings.find(candidate => candidate.declaration === declaration);
    const scope = enclosingFunction(declaration) || sourceFile;
    let input = null;
    const visit = candidate => {
      if (input) return;
      if (ts.isIdentifier(candidate) && candidate.text === declaration.name.text &&
          candidate !== declaration.name) {
        const resolved = resolveBinding(candidate, bindings);
        if (resolved === binding || resolved === declaration ||
            resolved === declaration.name || resolved?.declaration === declaration) {
          input = regexInput(candidate);
          if (input) return;
        }
      }
      ts.forEachChild(candidate, visit);
    };
    if (ts.isSourceFile(scope)) {
      visit(scope);
    } else {
      visit(scope.body || scope);
    }
    if (input) return input;
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

function isLexicalScope(node) {
  return Boolean(node) && (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) ||
    ts.isFunctionLike(node) || ts.isCatchClause(node) || ts.isForStatement(node) ||
    ts.isForInStatement(node) || ts.isForOfStatement(node));
}

function nearestLexicalScope(node) {
  let current = node.parent;
  while (current && !isLexicalScope(current)) current = current.parent;
  return current;
}

function nearestVariableScope(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

function variableDeclarationScope(node) {
  const declarationList = node.parent;
  if (ts.isVariableDeclarationList(declarationList) &&
      !(declarationList.flags & ts.NodeFlags.BlockScoped)) {
    return nearestVariableScope(node);
  }
  return nearestLexicalScope(node);
}

function collectBindings(sourceFile) {
  const bindings = [];
  const addPatternBindings = (pattern, declaration, scope) => {
    if (ts.isIdentifier(pattern)) {
      bindings.push({ declaration, name: pattern.text, scope });
      return;
    }
    if (!ts.isObjectBindingPattern(pattern) && !ts.isArrayBindingPattern(pattern)) return;
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element)) continue;
      addPatternBindings(element.name, element, scope);
    }
  };
  const visit = node => {
    let declaration = null;
    let name = null;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declaration = node;
      name = node.name.text;
    } else if (ts.isFunctionDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      declaration = node;
      name = node.name.text;
    } else if (ts.isFunctionExpression(node) && node.name && ts.isIdentifier(node.name)) {
      declaration = node;
      name = node.name.text;
    } else if (ts.isClassDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      declaration = node;
      name = node.name.text;
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      declaration = node;
      name = node.name.text;
    }
    if (declaration) {
      const scope = ts.isVariableDeclaration(declaration)
        ? variableDeclarationScope(declaration)
        : nearestLexicalScope(declaration);
      bindings.push({ declaration, name, scope });
    }
    if (ts.isVariableDeclaration(node) && !ts.isIdentifier(node.name)) {
      addPatternBindings(node.name, node, variableDeclarationScope(node));
    } else if (ts.isParameter(node) && !ts.isIdentifier(node.name)) {
      addPatternBindings(node.name, node, nearestLexicalScope(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function isAncestor(ancestor, node) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function scopeDepth(node) {
  let depth = 0;
  let current = node;
  while (current) {
    depth += 1;
    current = current.parent;
  }
  return depth;
}

function resolveBinding(reference, bindings) {
  if (!ts.isIdentifier(reference)) return null;
  const candidates = bindings.filter(binding => binding.name === reference.text &&
    isAncestor(binding.scope, reference));
  candidates.sort((left, right) => scopeDepth(right.scope) - scopeDepth(left.scope));
  return candidates[0]?.declaration || null;
}

function functionBinding(scope) {
  if (!scope) return null;
  const parent = scope.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.initializer === scope &&
      ts.isIdentifier(parent.name)) {
    return parent;
  }
  if (parent && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
      parent.initializer === scope && ts.isIdentifier(parent.name)) {
    return parent;
  }
  if (ts.isFunctionDeclaration(scope) && scope.name && ts.isIdentifier(scope.name)) return scope;
  if (scope.name && ts.isIdentifier(scope.name)) return scope;
  return null;
}

function bindingName(binding) {
  if ((ts.isVariableDeclaration(binding) || ts.isFunctionDeclaration(binding) ||
      ts.isFunctionExpression(binding) || ts.isClassDeclaration(binding) ||
      ts.isPropertyAssignment(binding) || ts.isPropertyDeclaration(binding)) &&
      binding.name && ts.isIdentifier(binding.name)) {
    return binding.name.text;
  }
  return null;
}

function hasBoundAlias(scope, subject, sourceFile, bindings, matches) {
  if (!ts.isIdentifier(subject)) return false;
  const subjectBinding = resolveBinding(subject, bindings);
  if (!subjectBinding) return false;
  if (ts.isVariableDeclaration(subjectBinding) &&
      matches(unwrapPolicyExpression(subjectBinding.initializer))) return true;
  let found = false;
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left) && node.left.text === subject.text &&
        resolveBinding(node.left, bindings) === subjectBinding &&
        matches(unwrapPolicyExpression(node.right))) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope || sourceFile);
  return found;
}

function isRoomKeyLookup(node) {
  return Boolean(node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'ownDataProperty' && node.arguments.length === 2 &&
    ts.isStringLiteralLike(node.arguments[1]) && ['guildId', 'channelId'].includes(node.arguments[1].text));
}

function isDescriptorRoomLookup(node) {
  return Boolean(node && ts.isCallExpression(node) && node.arguments.length === 2 &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object' &&
    node.expression.name.text === 'getOwnPropertyDescriptor' &&
    ts.isStringLiteralLike(node.arguments[1]) && ['guildId', 'channelId'].includes(node.arguments[1].text));
}

function hasRoomFieldAlias(scope, subject, sourceFile, bindings) {
  return hasBoundAlias(scope, subject, sourceFile, bindings, isNamedRoomField);
}

function hasRoomKeyAlias(scope, subject, sourceFile, bindings) {
  return hasBoundAlias(scope, subject, sourceFile, bindings, isRoomKeyLookup);
}

function hasDescriptorRoomAlias(scope, subject, sourceFile, bindings) {
  if (!ts.isIdentifier(subject)) return false;
  const valueBinding = resolveBinding(subject, bindings);
  if (!valueBinding || !ts.isVariableDeclaration(valueBinding) ||
      !valueBinding.initializer || !ts.isPropertyAccessExpression(valueBinding.initializer) ||
      valueBinding.initializer.name.text !== 'value' ||
      !ts.isIdentifier(valueBinding.initializer.expression)) return false;
  const descriptorBinding = resolveBinding(valueBinding.initializer.expression, bindings);
  return Boolean(descriptorBinding && ts.isVariableDeclaration(descriptorBinding) &&
    isDescriptorRoomLookup(unwrapPolicyExpression(descriptorBinding.initializer)));
}

function hasSplitRoomLengthBound(scope, subject, sourceFile) {
  const subjectText = subject.getText(sourceFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\W)${subjectText}\\s*\\.\\s*length\\s*(?:<=\\s*20|<\\s*21)(?:\\W|$)`).test(
    (scope || sourceFile).getText(sourceFile)
  );
}

function hasRoomFieldCall(scope, sourceFile, bindings, matches = isNamedRoomField) {
  const target = functionBinding(scope);
  const name = target ? bindingName(target) : null;
  if (!name) return false;
  let found = false;
  const resolvesToTarget = (reference, seen = new Set()) => {
    if (!ts.isIdentifier(reference)) return false;
    const binding = resolveBinding(reference, bindings);
    if (!binding || seen.has(binding)) return false;
    if (binding === target) return true;
    seen.add(binding);
    return ts.isVariableDeclaration(binding) && binding.initializer &&
      resolvesToTarget(binding.initializer, seen);
  };
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name &&
        node.arguments.length === 1 && matches(node.arguments[0]) &&
        resolveBinding(node.expression, bindings) === target) {
      found = true;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.arguments.length === 1 && matches(node.arguments[0]) &&
        resolvesToTarget(node.expression)) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isTownHallName(name) {
  return typeof name === 'string' && /town.?hall/i.test(name);
}

function isGenericRoomValidatorName(name) {
  return name === 'validateRoom';
}

function isRoomPolicyFile(sourceFile) {
  const fileName = sourceFile?.fileName || '';
  return /(?:room|town.?hall)/i.test(fileName) || /(?:^|[\\/])peer(?:[\\/]|$)/i.test(fileName);
}

function isTownHallContextName(name, sourceFile) {
  const fileName = sourceFile?.fileName || '';
  const neutralFile = /(?:ordinary|voice|snowflake)/i.test(fileName);
  return isTownHallName(name) ||
    (isGenericRoomValidatorName(name) && !neutralFile && isRoomPolicyFile(sourceFile));
}

function isAnonymousDefaultRoomPolicy(scope, sourceFile) {
  const fileName = sourceFile?.fileName || '';
  if (!isRoomPolicyFile(sourceFile) || !isTownHallName(fileName)) return false;
  if (ts.isFunctionDeclaration(scope)) {
    return !scope.name && scope.modifiers?.some(
      modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword,
    );
  }
  if (!ts.isArrowFunction(scope) && !ts.isFunctionExpression(scope)) return false;
  let current = scope;
  while (current.parent &&
      (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent))) {
    current = current.parent;
  }
  const assignment = current.parent;
  return ts.isExportAssignment(assignment) && !assignment.isExportEquals &&
    assignment.expression === current;
}

function hasTownHallDeclarationContext(scope, sourceFile) {
  let current = scope;
  while (current) {
    if (isAnonymousDefaultRoomPolicy(current, sourceFile)) return true;
    const binding = ts.isFunctionLike(current) ? functionBinding(current) : null;
    if (binding && isTownHallContextName(bindingName(binding), sourceFile)) return true;
    if (current.name && ts.isIdentifier(current.name) &&
        isTownHallContextName(current.name.text, sourceFile)) return true;
    current = current.parent;
  }
  const functionScope = enclosingFunction(scope) || (ts.isFunctionLike(scope) ? scope : null);
  return Boolean(functionScope?.parameters?.some(parameter => parameter.type &&
    isTownHallName(parameter.type.getText(sourceFile))));
}

function hasTownHallCallsite(scope, sourceFile, bindings) {
  const target = functionBinding(scope);
  if (!target) return false;
  let found = false;
  const visit = node => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        resolveBinding(node.expression, bindings) === target) {
      const caller = enclosingFunction(node);
      const callerBinding = caller && functionBinding(caller);
      if (callerBinding && isTownHallContextName(bindingName(callerBinding), sourceFile)) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isTownHallContext(scope, sourceFile, bindings) {
  return hasTownHallDeclarationContext(scope, sourceFile) ||
    hasTownHallCallsite(scope, sourceFile, bindings);
}

function hasDestructuredRoomParameter(subject, scope) {
  if (!ts.isIdentifier(subject) || !ts.isFunctionLike(scope)) return false;
  return scope.parameters.some(parameter => {
    if (!ts.isObjectBindingPattern(parameter.name)) return false;
    const containsRoomField = (pattern, roomContext, root = false) => pattern.elements.some(element => {
      if (!ts.isBindingElement(element)) return false;
      const key = element.propertyName || element.name;
      const keyText = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
      if (ts.isIdentifier(element.name) && element.name.text === subject.text &&
          (root || roomContext) && ['guildId', 'channelId'].includes(keyText)) return true;
      if (!ts.isObjectBindingPattern(element.name)) return false;
      const nestedRoomContext = roomContext ||
        /^(?:room|townHall|townHallRoom)$/i.test(keyText || '');
      return nestedRoomContext && containsRoomField(element.name, nestedRoomContext);
    });
    return containsRoomField(parameter.name, false, true);
  });
}

function isNeutralRoomPolicy(scope) {
  const owner = functionBinding(scope);
  const ownerName = scope?.name && ts.isIdentifier(scope.name)
    ? scope.name.text
    : owner ? bindingName(owner) : null;
  return /snowflake/i.test(ownerName || '');
}

function roomFieldSubject(node, sourceFile, bindings) {
  const subject = regexInput(node);
  if (!subject) return false;
  const scope = enclosingFunction(node) || sourceFile;
  if (isNeutralRoomPolicy(scope)) return false;
  const townHallContext = isTownHallContext(scope, sourceFile, bindings);
  if (!townHallContext) return false;
  return isNamedRoomField(subject) ||
    hasRoomFieldAlias(scope, subject, sourceFile, bindings) ||
    isRoomField(subject, bindings) ||
    hasDestructuredRoomParameter(subject, scope) ||
    hasBoundAlias(scope, subject, sourceFile, bindings, isRoomField) ||
    hasRoomKeyAlias(scope, subject, sourceFile, bindings) ||
    hasRoomFieldCall(scope, sourceFile, bindings, isRoomField) ||
    hasRoomFieldCall(scope, sourceFile, bindings);
}

function isTownHallRoomOwner(node, sourceFile, bindings) {
  const scope = enclosingFunction(node);
  const owner = scope && functionBinding(scope);
  if (!owner || bindingName(owner) !== 'isTownHallRoom') return false;
  const subject = regexInput(node);
  return Boolean(subject && (hasRoomKeyAlias(scope, subject, sourceFile, bindings) ||
    hasDescriptorRoomAlias(scope, subject, sourceFile, bindings)));
}

function isSplitRoomDigitPolicy(node, sourceFile, pattern, bindings) {
  if (!hasAsciiDigitPattern(pattern) ||
      !/(?:\\[dD]|\[[^\]]+\])(?:\+|\*|\{\d+(?:,\d*)?\})/.test(pattern)) return false;
  const subject = regexInput(node);
  if (!subject) return false;
  const scope = enclosingFunction(node) || sourceFile;
  return roomFieldSubject(node, sourceFile, bindings) && hasSplitRoomLengthBound(scope, subject, sourceFile);
}

function hasAsciiDigitPattern(pattern) {
  if (/\\[dD]/.test(pattern)) return true;
  if (/\\p\{(?:Decimal_Number|Nd)\}/.test(pattern)) return true;
  const classes = pattern.match(/\[(?:\^)?([^\]]*)\]/g) || [];
  return classes.some(characterClass => {
    const body = characterClass.replace(/^\[\^?/, '').replace(/\]$/, '');
    return /[0-9]-[0-9]/.test(body) || /[0-9]{2,}/.test(body);
  });
}

function resolveStringValue(expression, bindings, seen = new Set(), resolveImport = null) {
  const value = unwrapPolicyExpression(expression);
  if (ts.isStringLiteralLike(value)) return value.text;
  if (!ts.isIdentifier(value)) return null;
  const binding = resolveBinding(value, bindings);
  if (!binding) return resolveImport ? resolveImport(value, seen) : null;
  if (seen.has(binding)) return null;
  if (!binding.initializer) return null;
  seen.add(binding);
  return resolveStringValue(binding.initializer, bindings, seen, resolveImport);
}

function legacyRoomDigitPolicies(records, resolveImport = null) {
  const sites = {};
  for (const { file, text } of records) {
    const ast = createSourceFile(file, text);
    const bindings = collectBindings(ast);
    const visit = node => {
      let pattern = null;
      if (ts.isRegularExpressionLiteral(node)) pattern = node.text;
      else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
          ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' &&
          !resolveBinding(node.expression, bindings) &&
          node.arguments?.length) {
        pattern = resolveStringValue(node.arguments[0], bindings, new Set(),
          resolveImport ? (identifier, seen) => resolveImport(file, identifier, seen) : null);
      }
      const roomPolicy = pattern !== null && hasAsciiDigitPattern(pattern) &&
        (isTownHallRoomOwner(node, ast, bindings) || roomFieldSubject(node, ast, bindings) ||
          isSplitRoomDigitPolicy(node, ast, pattern, bindings));
      if (roomPolicy) {
        sites[file] = (sites[file] || 0) + 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return sites;
}

function unwrapPolicyExpression(node) {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) ||
      (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current)))) {
    current = current.expression;
  }
  return current;
}

function policyPropertyKey(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return null;
}

function roomDigitPolicies(records) {
  const infos = records.map(({ file, text }) => ({
    file,
    ast: createSourceFile(file, text),
    bindings: [],
    functions: new Map(),
    functionDefs: [],
    objectMethods: new Map(),
    imports: new Map(),
    exports: new Map(),
    starExports: [],
  }));
  const byFile = new Map(infos.map(info => [info.file, info]));

  const addPatternBindings = (pattern, source, info, extra) => {
    if (ts.isIdentifier(pattern)) {
      info.bindings.push({ name: pattern.text, kind: 'value', source, ...extra });
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;
        const keyNode = element.propertyName || element.name;
        if (ts.isIdentifier(element.name) && (ts.isIdentifier(keyNode) || ts.isStringLiteralLike(keyNode))) {
          info.bindings.push({
            name: element.name.text,
            kind: extra.kind === 'parameter' ? 'parameter-field' : 'field',
            key: keyNode.text,
            source,
            ...extra,
          });
        } else {
          addPatternBindings(element.name, source, info, extra);
        }
      }
    }
    if (ts.isArrayBindingPattern(pattern) && ts.isArrayLiteralExpression(source)) {
      for (let index = 0; index < pattern.elements.length; index += 1) {
        const element = pattern.elements[index];
        const sourceElement = source.elements[index];
        if (!ts.isBindingElement(element) || element.dotDotDotToken || !sourceElement ||
            ts.isOmittedExpression(sourceElement) || element.initializer) continue;
        addPatternBindings(element.name, sourceElement, info, extra);
      }
    }
  };

  for (const info of infos) {
    const visit = node => {
      if (ts.isVariableDeclaration(node) && !ts.isCatchClause(node.parent)) {
        const scope = variableDeclarationScope(node);
        addPatternBindings(node.name, node.initializer || null, info, {
          declaration: node,
          scope,
        });
        if (ts.isIdentifier(node.name) && node.initializer &&
            (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))) {
          const fn = {
            info,
            node: node.initializer,
            name: node.name.text,
            calls: [],
          };
          info.functions.set(node.name.text, fn);
          info.functionDefs.push(fn);
        }
      } else if (ts.isFunctionDeclaration(node)) {
        const name = node.name?.text ||
          (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : null);
        if (name) {
          const fn = {
            info,
            node,
            name,
            calls: [],
          };
          info.functions.set(name, fn);
          info.functionDefs.push(fn);
          if (node.name) {
            info.bindings.push({
              name: node.name.text,
              kind: 'function',
              declaration: node,
              scope: node.parent,
            });
          }
        }
      } else if (ts.isCatchClause(node) && node.variableDeclaration) {
        addPatternBindings(node.variableDeclaration.name, null, info, {
          kind: 'catch',
          declaration: node.variableDeclaration,
          scope: node,
        });
      } else if ((ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node)) && node.name &&
          (ts.isObjectLiteralExpression(node.parent) || ts.isClassDeclaration(node.parent))) {
        const owner = node.parent.parent;
        const property = node.name.text;
        let key = null;
        let ownerDeclaration = null;
        let instance = false;
        if (ts.isObjectLiteralExpression(node.parent) && ts.isVariableDeclaration(owner) &&
            ts.isIdentifier(owner.name) &&
            (ts.isMethodDeclaration(node) || ts.isFunctionExpression(node.initializer) ||
              ts.isArrowFunction(node.initializer))) {
          key = `${owner.name.text}.${property}`;
          ownerDeclaration = owner;
        } else if (ts.isClassDeclaration(node.parent) && node.parent.name &&
            ts.isMethodDeclaration(node)) {
          key = `${node.parent.name.text}.${property}`;
          ownerDeclaration = node.parent;
          instance = !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword);
        }
        if (key) {
          const fn = {
            info,
            node: ts.isPropertyAssignment(node) ? node.initializer : node,
            name: key,
            ownerDeclaration,
            instance,
            calls: [],
          };
          const methods = info.objectMethods.get(key) || [];
          methods.push(fn);
          info.objectMethods.set(key, methods);
          info.functionDefs.push(fn);
        }
      } else if (ts.isParameter(node)) {
        const fn = enclosingFunction(node);
        addPatternBindings(node.name, null, info, {
          kind: 'parameter',
          function: fn,
          ownerInfo: info,
          index: fn ? fn.parameters.indexOf(node) : -1,
          declaration: node,
          scope: fn,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);

    const importVisit = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        if (node.importClause?.name) {
          info.imports.set(node.importClause.name.text, { specifier, imported: 'default' });
          info.bindings.push({
            name: node.importClause.name.text,
            kind: 'import',
            declaration: node.importClause.name,
            scope: info.ast,
            specifier,
            imported: 'default',
          });
        }
        if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            info.imports.set(element.name.text, {
              specifier,
              imported: element.propertyName?.text || element.name.text,
            });
            info.bindings.push({
              name: element.name.text,
              kind: 'import',
              declaration: element.name,
              scope: info.ast,
              specifier,
              imported: element.propertyName?.text || element.name.text,
            });
          }
        }
        if (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
          const name = node.importClause.namedBindings.name.text;
          info.imports.set(name, { specifier, namespace: true });
          info.bindings.push({
            name,
            kind: 'namespace-import',
            declaration: node.importClause.namedBindings.name,
            scope: info.ast,
            specifier,
          });
        }
      }
      ts.forEachChild(node, importVisit);
    };
    importVisit(info.ast);

    const commonJsImport = node => {
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        const name = node.name.text;
        const specifier = node.moduleReference.expression.text;
        info.imports.set(name, { specifier, imported: 'default', commonJs: true });
        info.bindings.push({
          name,
          kind: 'commonjs-import',
          declaration: node.name,
          scope: variableDeclarationScope(node),
          specifier,
          imported: 'default',
        });
      }
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          const initializer = declaration.initializer;
          let specifier;
          let imported;
          const dynamicImportExpression = initializer && ts.isAwaitExpression(initializer)
            ? initializer.expression
            : initializer;
          let dynamicImport = false;
          if (dynamicImportExpression && ts.isCallExpression(dynamicImportExpression) &&
              dynamicImportExpression.expression.kind === ts.SyntaxKind.ImportKeyword &&
              dynamicImportExpression.arguments.length === 1 &&
              ts.isStringLiteralLike(dynamicImportExpression.arguments[0])) {
            specifier = dynamicImportExpression.arguments[0].text;
            imported = 'default';
            dynamicImport = true;
          } else if (
            initializer &&
            ts.isCallExpression(initializer) &&
            ts.isIdentifier(initializer.expression) &&
            initializer.expression.text === 'require' &&
            initializer.arguments.length === 1 &&
            ts.isStringLiteralLike(initializer.arguments[0])
          ) {
            specifier = initializer.arguments[0].text;
            imported = 'default';
          } else if (
            initializer &&
            ts.isPropertyAccessExpression(initializer) &&
            ts.isCallExpression(initializer.expression) &&
            ts.isIdentifier(initializer.expression.expression) &&
            initializer.expression.expression.text === 'require' &&
            initializer.expression.arguments.length === 1 &&
            ts.isStringLiteralLike(initializer.expression.arguments[0])
          ) {
            specifier = initializer.expression.arguments[0].text;
            imported = initializer.name.text;
          }
          if (!specifier) continue;
          if (ts.isIdentifier(declaration.name)) {
            info.imports.set(declaration.name.text, {
              specifier,
              imported,
              commonJs: !dynamicImport,
              dynamic: dynamicImport,
              declaration: dynamicImport ? declaration.name : undefined,
            });
            info.bindings.push({
              name: declaration.name.text,
              kind: dynamicImport ? 'import' : 'commonjs-import',
              declaration: declaration.name,
              scope: variableDeclarationScope(declaration),
              source: initializer,
              specifier,
              imported,
            });
          } else if (ts.isObjectBindingPattern(declaration.name)) {
            for (const element of declaration.name.elements) {
              if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
              const propertyName = element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
              info.imports.set(element.name.text, {
                specifier,
                imported: propertyName,
                commonJs: !dynamicImport,
                dynamic: dynamicImport,
                declaration: dynamicImport ? element : undefined,
              });
              info.bindings.push({
                name: element.name.text,
                kind: dynamicImport ? 'import' : 'commonjs-import',
                declaration: element.name,
                scope: variableDeclarationScope(declaration),
                source: initializer,
                specifier,
                imported: propertyName,
              });
            }
          }
        }
      }
      ts.forEachChild(node, commonJsImport);
    };
    commonJsImport(info.ast);

    const indexCommonJsFunction = (exportName, node) => {
      const fn = {
        info,
        node,
        name: node.name?.text || exportName,
        calls: [],
      };
      info.exports.set(exportName, fn);
      info.functionDefs.push(fn);
    };
    const regexBindings = collectBindings(info.ast);
    const regexExpression = expression => {
      const value = unwrapPolicyExpression(expression);
      if (ts.isRegularExpressionLiteral(value)) return { node: value, pattern: value.text };
      if ((ts.isNewExpression(value) || ts.isCallExpression(value)) &&
          ts.isIdentifier(value.expression) && value.expression.text === 'RegExp' &&
          value.arguments?.length) {
        const pattern = resolveStringValue(value.arguments[0], regexBindings);
        if (pattern !== null) return { node: value, pattern };
      }
      return null;
    };
    const indexCommonJsRegex = (exportName, expression) => {
      const regex = regexExpression(expression);
      if (regex) info.exports.set(exportName, { kind: 'regex', ...regex });
    };
    const commonJsExportVisit = node => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const assignment = commonJsExportAssignment(node);
        const target = assignment?.target || null;
        if (target && ts.isIdentifier(node.right)) {
          info.exports.set(target, node.right.text);
        } else if (target && regexExpression(node.right)) {
          indexCommonJsRegex(target, node.right);
        } else if (assignment?.reExport) {
          const { specifier, importedName } = assignment.reExport;
          info.exports.set(target, { kind: 'reexport', specifier, imported: importedName });
          if (target === 'default' && importedName === 'default' &&
              !info.starExports.includes(specifier)) {
            info.starExports.push(specifier);
          }
        } else if (target === 'default' && ts.isObjectLiteralExpression(node.right)) {
          for (const property of node.right.properties) {
            if (ts.isShorthandPropertyAssignment(property)) {
              info.exports.set(property.name.text, property.name.text);
            } else if (ts.isMethodDeclaration(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
              indexCommonJsFunction(property.name.text, property);
            } else if (ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                ts.isIdentifier(property.initializer)) {
              info.exports.set(property.name.text, property.initializer.text);
            } else if (ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                (ts.isFunctionExpression(property.initializer) || ts.isArrowFunction(property.initializer))) {
              indexCommonJsFunction(property.name.text, property.initializer);
            } else if (ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                regexExpression(property.initializer)) {
              indexCommonJsRegex(property.name.text, property.initializer);
            }
          }
        } else if (target &&
            (ts.isFunctionExpression(node.right) || ts.isArrowFunction(node.right))) {
          indexCommonJsFunction(target, node.right);
        }
      }
      ts.forEachChild(node, commonJsExportVisit);
    };
    commonJsExportVisit(info.ast);

    for (const statement of info.ast.statements) {
      if (ts.isExportDeclaration(statement)) {
        const specifier = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const imported = element.propertyName?.text || element.name.text;
            info.exports.set(element.name.text, specifier
              ? { kind: 'reexport', specifier, imported }
              : imported);
          }
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause) && specifier) {
          info.exports.set(statement.exportClause.name.text, { kind: 'namespace', specifier });
        } else if (!statement.exportClause && specifier) {
          info.starExports.push(specifier);
        }
      }
      if (ts.isExportAssignment(statement)) {
        if (ts.isFunctionExpression(statement.expression) || ts.isArrowFunction(statement.expression)) {
          indexCommonJsFunction('default', statement.expression);
        } else if (regexExpression(statement.expression)) {
          indexCommonJsRegex('default', statement.expression);
        } else if (statement.isExportEquals && ts.isIdentifier(statement.expression)) {
          info.exports.set('default', statement.expression.text);
        } else if (!statement.isExportEquals && ts.isObjectLiteralExpression(statement.expression)) {
          for (const property of statement.expression.properties) {
            if (ts.isMethodDeclaration(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))) {
              indexCommonJsFunction(property.name.text, property);
            } else if (ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                ts.isIdentifier(property.initializer)) {
              info.exports.set(property.name.text, property.initializer.text);
            } else if (ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                (ts.isFunctionExpression(property.initializer) || ts.isArrowFunction(property.initializer))) {
              indexCommonJsFunction(property.name.text, property.initializer);
            } else if (ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) &&
                regexExpression(property.initializer)) {
              indexCommonJsRegex(property.name.text, property.initializer);
            }
          }
        } else if (ts.isIdentifier(statement.expression)) {
          info.exports.set('default', statement.expression.text);
        }
      }
      if (ts.isFunctionDeclaration(statement) &&
          statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        const exportedName = statement.name?.text || 'default';
        info.exports.set(exportedName, exportedName);
        if (statement.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
          info.exports.set('default', exportedName);
        }
      }
      if (ts.isVariableStatement(statement) &&
          statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) info.exports.set(declaration.name.text, declaration.name.text);
        }
      }
    }
  }

  const moduleGraph = createPolicyModuleGraph({
    ts,
    path,
    infos,
    byFile,
    collectBindings,
    unwrapPolicyExpression,
    policyPropertyKey,
    isAncestor,
    nearestLexicalScope,
    scopeDepth,
    variableDeclarationScope,
    functionBinding,
    bindingName,
    enclosingFunction,
  });
  const {
    resolveModule,
    resolveExportedFunction,
    resolveImported,
    resolveFunction,
    findBinding,
    bindingCalls,
  } = moduleGraph;

  const objectIsRoom = (node, info, seen = new Set()) => {
    const expression = unwrapPolicyExpression(node);
    if (!expression) return false;
    if (ts.isIdentifier(expression)) {
      if (/^(?:room|townHall|townHallRoom)$/i.test(expression.text)) return true;
      const binding = findBinding(info, expression.text, expression);
      if (!binding || seen.has(binding)) return false;
      seen.add(binding);
      if (binding.kind === 'value' && binding.source) return objectIsRoom(binding.source, info, seen);
      if (binding.kind === 'parameter') {
        return bindingCalls(binding, info).some(call => call.args[binding.index] &&
          objectIsRoom(call.args[binding.index], call.info, new Set(seen)));
      }
    }
    return false;
  };
  const expressionIsRoomField = (node, info, seen = new Set()) => {
    const expression = unwrapPolicyExpression(node);
    if (!expression) return false;
    if (ts.isBinaryExpression(expression) &&
        [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
          expression.operatorToken.kind,
        )) {
      return expressionIsRoomField(expression.left, info, new Set(seen)) &&
        expressionIsRoomField(expression.right, info, new Set(seen));
    }
    if (ts.isConditionalExpression(expression)) {
      return expressionIsRoomField(expression.whenTrue, info, new Set(seen)) &&
        expressionIsRoomField(expression.whenFalse, info, new Set(seen));
    }
    if (ts.isCallExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        ['String', 'Number', 'BigInt'].includes(expression.expression.text) &&
        expression.arguments.length === 1) {
      return expressionIsRoomField(expression.arguments[0], info, seen);
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
        ['trim', 'toString'].includes(expression.expression.name.text) &&
        expression.arguments.length === 0) {
      return expressionIsRoomField(expression.expression.expression, info, seen);
    }
    const key = policyPropertyKey(expression);
    if (key && ['guildId', 'channelId'].includes(key)) {
      const object = expression.expression;
      if (objectIsRoom(object, info, new Set(seen))) return true;
    }
    if (!ts.isIdentifier(expression)) return false;
    const binding = findBinding(info, expression.text, expression);
    if (!binding || seen.has(binding)) return false;
    seen.add(binding);
    if (binding.kind === 'value' && binding.source) {
      return expressionIsRoomField(binding.source, info, seen);
    }
    if ((binding.kind === 'field' || binding.kind === 'parameter-field') &&
        ['guildId', 'channelId'].includes(binding.key)) {
      if (binding.kind === 'field') return objectIsRoom(binding.source, info, new Set(seen));
      return bindingCalls(binding, info).some(call => call.args[binding.index] &&
        objectIsRoom(call.args[binding.index], call.info, new Set(seen)));
    }
    if (binding.kind === 'parameter') {
      return bindingCalls(binding, info).some(call => call.args[binding.index] &&
        expressionIsRoomField(call.args[binding.index], call.info, new Set(seen)));
    }
    return false;
  };
  const hasContextualParameterCall = (binding) => {
    if (!binding || binding.kind !== 'parameter') return false;
    return bindingCalls(binding, binding.ownerInfo).some(call => {
      const caller = call.node && enclosingFunction(call.node);
      const callerBinding = caller && functionBinding(caller);
      const callerName = callerBinding ? bindingName(callerBinding) : null;
      return isTownHallContextName(callerName, call.info.ast) &&
        call.args[binding.index] && expressionIsRoomField(call.args[binding.index], call.info);
    });
  };
  const regexAnalysis = createPolicyRegexAnalysis({
    ts,
    infos,
    byFile,
    resolveBinding,
    resolveModule,
    resolveFunction,
    findBinding,
    bindingCalls,
    objectIsRoom,
    expressionIsRoomField,
    hasContextualParameterCall,
    borrowedStringInput,
    regexInput,
    collectBindings,
    callPropertyName,
    isAncestor,
    enclosingFunction,
    unwrapPolicyExpression,
    policyPropertyKey,
    resolveStringValue,
    hasAsciiDigitPattern,
    isTownHallContext,
    isNeutralRoomPolicy,
    isTownHallRoomOwner,
    roomFieldSubject,
    isSplitRoomDigitPolicy,
  });
  const {
    regexInputs,
    importedRegexInputs,
    namespaceRegexInputs,
    directDynamicImportRegexInputs,
    resolveRegexExport,
    resolveNamespaceExport,
    resolveImportedString,
  } = regexAnalysis;

  const sites = legacyRoomDigitPolicies(records, (file, identifier, seen) => {
    const info = byFile.get(file);
    return info ? resolveImportedString(info, identifier, seen) : null;
  });
  for (const info of infos) {
    const legacyBindings = collectBindings(info.ast);
    const visit = node => {
      let pattern = null;
      if (ts.isRegularExpressionLiteral(node)) pattern = node.text;
      else if ((ts.isNewExpression(node) || ts.isCallExpression(node)) &&
          ts.isIdentifier(node.expression) && node.expression.text === 'RegExp' &&
          !resolveBinding(node.expression, legacyBindings) &&
          node.arguments?.length) {
        pattern = resolveStringValue(node.arguments[0], legacyBindings, new Set(),
          (identifier, seen) => resolveImportedString(info, identifier, seen));
      }
      if (pattern !== null && hasAsciiDigitPattern(pattern)) {
        const legacyPolicy = isTownHallRoomOwner(node, info.ast, legacyBindings) ||
          roomFieldSubject(node, info.ast, legacyBindings) ||
          isSplitRoomDigitPolicy(node, info.ast, pattern, legacyBindings);
        const isRoomInput = input => {
          const inputScope = enclosingFunction(input) || info.ast;
          const roomContext = isTownHallContext(inputScope, info.ast, legacyBindings);
          if (isNeutralRoomPolicy(inputScope)) return false;
          if (roomContext && (expressionIsRoomField(input, info) || isRoomField(input, legacyBindings))) return true;
          const binding = ts.isIdentifier(input) && findBinding(info, input.text, input);
          return Boolean(!roomContext && hasContextualParameterCall(binding));
        };
        if (!legacyPolicy && regexInputs(node, info).some(isRoomInput)) {
          sites[info.file] = (sites[info.file] || 0) + 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
  }
  const countedRegexExports = new Set();
  const countImportedRegexPolicy = (consumer, consumerBindings, target, importedName, input) => {
    const resolved = target && resolveRegexExport(target, importedName);
    if (!resolved || !hasAsciiDigitPattern(resolved.pattern)) return;
    const scope = enclosingFunction(input) || consumer.ast;
    const binding = ts.isIdentifier(input) && findBinding(consumer, input.text, input);
    const roomContext = isTownHallContext(scope, consumer.ast, consumerBindings) ||
      hasContextualParameterCall(binding);
    if (isNeutralRoomPolicy(scope) || !roomContext || !expressionIsRoomField(input, consumer)) return;
    const key = `${resolved.info.file}\u0000${resolved.declaration?.pos ?? resolved.pattern}`;
    const localInputs = resolved.declaration && ts.isVariableDeclaration(resolved.declaration)
      ? regexInputs(resolved.declaration.initializer, resolved.info)
      : [];
    if (localInputs.some(input => expressionIsRoomField(input, resolved.info))) {
      countedRegexExports.add(key);
      return;
    }
    if (!countedRegexExports.has(key)) {
      sites[resolved.info.file] = (sites[resolved.info.file] || 0) + 1;
      countedRegexExports.add(key);
    }
  };
  for (const consumer of infos) {
    const consumerBindings = collectBindings(consumer.ast);
    for (const [localName, imported] of consumer.imports) {
      const defaultImport = imported.imported === 'default';
      const target = resolveModule(consumer, imported.specifier);
      const namespaceTarget = !imported.namespace && !defaultImport && target
        ? resolveNamespaceExport(target, imported.imported)
        : null;
      let references;
      if (imported.namespace || namespaceTarget) {
        references = namespaceRegexInputs(consumer, localName);
      } else if (defaultImport) {
        references = [
          ...importedRegexInputs(consumer, localName, imported)
            .map(input => ({ importedName: imported.imported, input })),
          ...namespaceRegexInputs(consumer, localName),
        ];
      } else {
        references = importedRegexInputs(consumer, localName, imported)
          .map(input => ({ importedName: imported.imported, input }));
      }
      for (const { importedName, input } of references) {
        const resolvedTarget = namespaceTarget || target;
        countImportedRegexPolicy(consumer, consumerBindings, resolvedTarget, importedName, input);
      }
    }
    for (const { specifier, importedName, input } of directDynamicImportRegexInputs(consumer)) {
      countImportedRegexPolicy(
        consumer,
        consumerBindings,
        resolveModule(consumer, specifier),
        importedName,
        input,
      );
    }
  }
  return sites;
}

module.exports = {
  createSourceFile,
  finiteStringValues,
  isRoomField,
  isNamedRoomField,
  callPropertyName,
  regexInput,
  enclosingFunction,
  isLexicalScope,
  nearestLexicalScope,
  nearestVariableScope,
  variableDeclarationScope,
  collectBindings,
  isAncestor,
  scopeDepth,
  resolveBinding,
  functionBinding,
  bindingName,
  hasBoundAlias,
  isRoomKeyLookup,
  isDescriptorRoomLookup,
  hasRoomFieldAlias,
  hasRoomKeyAlias,
  hasDescriptorRoomAlias,
  hasSplitRoomLengthBound,
  hasRoomFieldCall,
  isTownHallName,
  isGenericRoomValidatorName,
  isRoomPolicyFile,
  isTownHallContextName,
  isAnonymousDefaultRoomPolicy,
  hasTownHallDeclarationContext,
  hasTownHallCallsite,
  isTownHallContext,
  hasDestructuredRoomParameter,
  isNeutralRoomPolicy,
  roomFieldSubject,
  isTownHallRoomOwner,
  isSplitRoomDigitPolicy,
  hasAsciiDigitPattern,
  resolveStringValue,
  legacyRoomDigitPolicies,
  unwrapPolicyExpression,
  policyPropertyKey,
  roomDigitPolicies,
};
