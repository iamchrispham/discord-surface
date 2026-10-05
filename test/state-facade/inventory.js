const crypto = require('node:crypto');

const assert = require('node:assert/strict');

const fs = require('node:fs');

const path = require('node:path');

const ts = require('typescript');

function tokens(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const result = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) result.push([scanner.getTokenText(), scanner.hasPrecedingLineBreak()]);
  return result;
}

function propertyName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

const stateSourcePath = path.resolve(__dirname, '../../src/state.js');

function factoryDeclaration(source, factoryName) {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === factoryName) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === factoryName &&
          declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        return declaration.initializer;
      }
    }
  }
  return null;
}

const INVOCATION_STYLES = Object.freeze({ THIS: 'this', STATE: 'state', PURE: 'pure' });

function invocationStyle(node) {
  let usesThis = false;
  const visit = current => {
    if (current !== node && ts.isFunctionLike(current) && !ts.isArrowFunction(current)) return;
    if (current.kind === ts.SyntaxKind.ThisKeyword) usesThis = true;
    ts.forEachChild(current, visit);
  };
  visit(node);
  const parameters = (node.parameters || []).filter(parameter =>
    !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'));
  const first = parameters[0];
  const hasStateParameter = parameters.some(parameter =>
    ts.isIdentifier(parameter.name) && ['state', 'surface'].includes(parameter.name.text));
  if (first && ts.isIdentifier(first.name) && ['state', 'surface'].includes(first.name.text)) {
    return INVOCATION_STYLES.STATE;
  }
  if (hasStateParameter && !usesThis) {
    return INVOCATION_STYLES.STATE;
  }
  if (usesThis) return INVOCATION_STYLES.THIS;
  return INVOCATION_STYLES.PURE;
}

function callableDeclarations(source, factory) {
  const declarations = new Map();
  const add = (name, declaration) => {
    if (name) declarations.set(name, declaration);
  };
  const visitSource = node => {
    if (ts.isFunctionDeclaration(node)) {
      add(node.name?.text, node);
      return;
    }
    if (ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      add(node.name.text, node);
    }
    ts.forEachChild(node, visitSource);
  };
  visitSource(source);
  const visitFactory = node => {
    if (node !== factory && ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node)) add(node.name?.text, node);
      return;
    }
    if (ts.isFunctionDeclaration(node)) add(node.name?.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      add(node.name.text, node);
    }
    ts.forEachChild(node, visitFactory);
  };
  visitFactory(factory);
  return declarations;
}

function callableDescriptor(node) {
  if (!node || !ts.isFunctionLike(node)) return null;
  const parameters = (node.parameters || []).filter(parameter =>
    !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'));
  const style = invocationStyle(node);
  const postStateParameters = style === INVOCATION_STYLES.STATE ? parameters.slice(1) : parameters;
  const requiredArguments = postStateParameters.filter(parameter =>
    !parameter.initializer && !parameter.dotDotDotToken).length;
  return { style, requiredArguments };
}

function collectFactoryMethods(factory, source, resolveExpression = () => new Map(), resolveImportedValue = () => null) {
  const methods = new Map();
  const declarations = callableDeclarations(source, factory);
  const resolving = new Set();
  const resolveValue = expression => {
    if (!expression) return null;
    const direct = callableDescriptor(expression);
    if (direct) return direct;
    if (ts.isIdentifier(expression)) {
      if (resolving.has(expression.text)) return null;
      const declaration = declarations.get(expression.text);
      if (!declaration) return null;
      resolving.add(expression.text);
      const resolved = ts.isVariableDeclaration(declaration)
        ? resolveValue(declaration.initializer)
        : callableDescriptor(declaration);
      resolving.delete(expression.text);
      return resolved;
    }
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === 'bind') {
      const descriptor = resolveValue(expression.expression.expression);
      if (!descriptor) return null;
      const boundArguments = Math.max(0, expression.arguments.length - 1);
      return { ...descriptor, requiredArguments: Math.max(0, descriptor.requiredArguments - boundArguments) };
    }
    if (!ts.isPropertyAccessExpression(expression)) return null;
    const receiver = expression.expression;
    if (ts.isIdentifier(receiver)) {
      const imported = resolveImportedValue(receiver.text, expression.name.text);
      if (imported) return imported;
      const declaration = declarations.get(receiver.text);
      if (declaration && ts.isVariableDeclaration(declaration)) {
        const resolved = resolveExpression(declaration.initializer);
        return resolved.get(expression.name.text) || null;
      }
    }
    if (ts.isCallExpression(receiver)) {
      const resolved = resolveExpression(receiver);
      return resolved.get(expression.name.text) || null;
    }
    return null;
  };
  const collectObject = object => {
    const methods = new Map();
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const [method, descriptor] of resolveReturnedExpression(property.expression)) methods.set(method, descriptor);
        continue;
      }
      const name = propertyName(property.name);
      if (!name) continue;
      let descriptor = null;
      if (ts.isMethodDeclaration(property)) descriptor = callableDescriptor(property);
      else if (ts.isShorthandPropertyAssignment(property)) descriptor = resolveValue(property.name);
      else if (ts.isPropertyAssignment(property)) descriptor = resolveValue(property.initializer);
      // Keep noncallable values so later properties shadow earlier handlers.
      methods.set(name, descriptor);
    }
    return methods;
  };
  const resolveReturnedExpression = (expression, seen = new Set()) => {
    if (!expression) return new Map();
    let current = expression;
    while (ts.isParenthesizedExpression(current)) current = current.expression;
    if (ts.isObjectLiteralExpression(current)) return collectObject(current);
    if (ts.isIdentifier(current)) {
      const declaration = declarations.get(current.text);
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        const key = declaration.getStart(source);
        if (seen.has(key)) return new Map();
        const next = new Set(seen);
        next.add(key);
        return resolveReturnedExpression(declaration.initializer, next);
      }
    }
    return resolveExpression(current);
  };
  const body = factory.body;
  const returns = body && ts.isBlock(body)
    ? body.statements.filter(statement => ts.isReturnStatement(statement)).map(statement => statement.expression).filter(Boolean)
    : [body];
  for (const expression of returns) {
    for (const [method, descriptor] of resolveReturnedExpression(expression)) methods.set(method, descriptor);
  }
  return methods;
}

function moduleCallableDescriptor(filePath, methodName, seen = new Set()) {
  const key = `${filePath}:${methodName}`;
  if (seen.has(key)) return null;
  seen.add(key);
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const local = factoryDeclaration(source, methodName);
    if (local) return callableDescriptor(local);
    const bindings = requireBindings(source);
    const exported = exportedFactoryExpression(source, methodName);
    const exportedName = exported && ts.isIdentifier(exported) ? exported.text : null;
    const receiverBinding = exported && ts.isPropertyAccessExpression(exported) && ts.isIdentifier(exported.expression)
      ? bindings.get(exported.expression.text)
      : null;
    const binding = bindings.get(exportedName || methodName) || receiverBinding;
    const exportedReceiver = exported && ts.isPropertyAccessExpression(exported) ? exported.expression : null;
    const modulePath = binding?.modulePath || directRequire(exportedReceiver) || directRequire(exported);
    if (!modulePath) return null;
    const importedPath = resolveModulePath(modulePath, filePath);
    if (!importedPath) return null;
    const importedName = exported && ts.isPropertyAccessExpression(exported)
      ? exported.name.text
      : binding?.exportName || methodName;
    return moduleCallableDescriptor(importedPath, importedName, seen);
  }
  catch {
    return null;
  }
}

function requireBindings(source) {
  const bindings = new Map();
  const visit = node => {
    if (node !== source && ts.isFunctionLike(node)) return;
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!declaration.initializer || !ts.isCallExpression(declaration.initializer) ||
            !ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== 'require' ||
            declaration.initializer.arguments.length !== 1 || !ts.isStringLiteral(declaration.initializer.arguments[0])) continue;
        const modulePath = declaration.initializer.arguments[0].text;
        if (ts.isIdentifier(declaration.name)) {
          bindings.set(declaration.name.text, { modulePath, exportName: null });
          continue;
        }
        if (!ts.isObjectBindingPattern(declaration.name)) continue;
        for (const element of declaration.name.elements) {
          if (!ts.isBindingElement(element)) continue;
          const imported = propertyName(element.propertyName || element.name);
          const local = ts.isIdentifier(element.name) ? element.name.text : null;
          if (imported && local) bindings.set(local, { modulePath, exportName: imported });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function resolveModulePath(modulePath, sourcePath) {
  if (!modulePath?.startsWith('.')) return null;
  try {
    return require.resolve(modulePath, { paths: [path.dirname(sourcePath)] });
  }
  catch {
    return null;
  }
}

function calledFactory(expression) {
  let target = ts.isCallExpression(expression) ? expression.expression : expression;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.CommaToken) target = target.right;
  if (ts.isIdentifier(target)) return { name: target.text, receiver: null };
  if (ts.isPropertyAccessExpression(target)) return { name: target.name.text, receiver: target.expression };
  return null;
}

function directRequire(receiver) {
  if (!receiver || !ts.isCallExpression(receiver) || !ts.isIdentifier(receiver.expression) || receiver.expression.text !== 'require' ||
      receiver.arguments.length !== 1 || !ts.isStringLiteral(receiver.arguments[0])) return null;
  return receiver.arguments[0].text;
}

function exportedFactoryExpression(source, factoryName) {
  let result = null;
  const isModuleExports = node => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' && node.name.text === 'exports';
  const isNamedExport = node => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) &&
    node.expression.text === 'exports' && node.name.text === factoryName;
  const getterExpression = node => {
    if (!ts.isObjectLiteralExpression(node)) return null;
    for (const property of node.properties) {
      if (propertyName(property.name) !== 'get' || !property.initializer || !ts.isFunctionLike(property.initializer)) continue;
      const body = property.initializer.body;
      if (!body || !ts.isBlock(body)) continue;
      const statement = body.statements.find(item => ts.isReturnStatement(item) && item.expression);
      if (statement) return statement.expression;
    }
    return null;
  };
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (isNamedExport(node.left)) result = node.right;
      if (isModuleExports(node.left)) {
        if (ts.isObjectLiteralExpression(node.right)) {
          for (const property of node.right.properties) {
            if (propertyName(property.name) !== factoryName) continue;
            result = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
          }
        }
        else {
          result = node.right;
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object' &&
        node.expression.name.text === 'defineProperty' && node.arguments.length >= 3 &&
        ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === 'exports' &&
        ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === factoryName) {
      result = getterExpression(node.arguments[2]) || result;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function reexportedModulePath(source) {
  let result = null;
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === '__exportStar') {
      result = directRequire(node.arguments[0]) || result;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function factoryMethodsFromSource(source, sourcePath, factoryName, seen) {
  const key = `${sourcePath}:${factoryName}`;
  if (seen.has(key)) return new Map();
  seen.add(key);
  const factory = factoryDeclaration(source, factoryName);
  if (!factory) return null;
  const bindings = requireBindings(source);
  const resolveExpression = expression => {
    const called = calledFactory(expression);
    if (!called) return new Map();
    const local = factoryMethodsFromSource(source, sourcePath, called.name, new Set(seen));
    if (local?.size) return local;
    const binding = called.receiver
      ? (ts.isIdentifier(called.receiver) ? bindings.get(called.receiver.text) : null)
      : bindings.get(called.name);
    const modulePath = directRequire(called.receiver) || binding?.modulePath;
    if (!modulePath) return new Map();
    const importedPath = resolveModulePath(modulePath, sourcePath);
    if (!importedPath) return new Map();
    const importedName = called.receiver && ts.isPropertyAccessExpression(called.receiver)
      ? called.name
      : binding?.exportName || called.name;
    return moduleFactoryMethods(importedPath, importedName, new Set(seen));
  };
  const resolveImportedValue = (receiverName, methodName) => {
    const binding = bindings.get(receiverName);
    if (!binding) return null;
    const importedPath = resolveModulePath(binding.modulePath, sourcePath);
    return importedPath ? moduleCallableDescriptor(importedPath, methodName) : null;
  };
  return collectFactoryMethods(factory, source, resolveExpression, resolveImportedValue);
}

function moduleFactoryMethods(filePath, factoryName, seen) {
  try {
    const importedText = fs.readFileSync(filePath, 'utf8');
    const importedSource = ts.createSourceFile(filePath, importedText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const local = factoryMethodsFromSource(importedSource, filePath, factoryName, seen);
    if (local?.size) return local;
    const bindings = requireBindings(importedSource);
    const exported = exportedFactoryExpression(importedSource, factoryName);
    const exportedName = exported && ts.isIdentifier(exported) ? exported.text : null;
    const receiverBinding = exported && ts.isPropertyAccessExpression(exported) && ts.isIdentifier(exported.expression)
      ? bindings.get(exported.expression.text)
      : null;
    const binding = bindings.get(exportedName || factoryName) || receiverBinding;
    const exportedReceiver = exported && ts.isPropertyAccessExpression(exported) ? exported.expression : null;
    const modulePath = binding?.modulePath || directRequire(exportedReceiver) || directRequire(exported) || reexportedModulePath(importedSource);
    if (!modulePath) return new Map();
    const importedPath = resolveModulePath(modulePath, filePath);
    if (!importedPath) return new Map();
    const importedName = exported && ts.isPropertyAccessExpression(exported)
      ? exported.name.text
      : binding?.exportName || factoryName;
    return moduleFactoryMethods(importedPath, importedName, seen);
  }
  catch {
    return new Map();
  }
}

function factoryMethods(source, factoryName) {
  const methods = factoryMethodsFromSource(source, stateSourcePath, factoryName, new Set());
  return methods?.size ? methods : null;
}

function importedFactoryMethods(source, factoryName) {
  return factoryMethods(source, factoryName) || moduleFactoryMethods(stateSourcePath, factoryName, new Set());
}

function inventory(text) {
  const source = ts.createSourceFile('state.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(source.parseDiagnostics.length, 0);
  const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SurfaceState');
  assert.ok(owner);
  const handlers = new Set();
  const handlerFactories = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text.endsWith('Handlers') &&
          declaration.initializer && ts.isCallExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text.startsWith('create')) {
        handlers.add(declaration.name.text);
        handlerFactories.set(declaration.name.text, declaration.initializer.expression.text);
      }
    }
  }
  const handlerMethodDescriptors = Object.fromEntries([...handlerFactories].map(([name, factory]) => [name, importedFactoryMethods(source, factory)]));
  const callableMethods = methods => [...methods].filter(([, descriptor]) => descriptor);
  const handlerMethods = Object.fromEntries(Object.entries(handlerMethodDescriptors).map(([name, methods]) => [name,
    callableMethods(methods).map(([method]) => method).sort()]));
  const handlerContracts = Object.fromEntries(Object.entries(handlerMethodDescriptors).map(([name, methods]) => [name,
    Object.fromEntries(callableMethods(methods).map(([method, descriptor]) => [method, descriptor.style]))]));
  const handlerRequiredArguments = Object.fromEntries(Object.entries(handlerMethodDescriptors).map(([name, methods]) => [name,
    Object.fromEntries(callableMethods(methods).map(([method, descriptor]) => [method, descriptor.requiredArguments]))]));
  const classHeader = tokens(text.slice(owner.getStart(source), owner.members.pos));
  const topLevel = source.statements.filter(node => node !== owner).map(node => tokens(node.getText(source)));
  const bodies = Object.create(null);
  const delegationBodies = Object.create(null);
  const forwarding = [];
  for (const method of owner.members) {
    assert.ok(ts.isMethodDeclaration(method) || ts.isConstructorDeclaration(method), 'unsupported class member');
    assert.ok(method.body);
    if (ts.isMethodDeclaration(method)) assert.ok(ts.isIdentifier(method.name), 'unsupported method name');
    const name = ts.isConstructorDeclaration(method) ? 'constructor' : method.name.text;
    assert.equal(Object.hasOwn(bodies, name) || forwarding.includes(name), false, `duplicate method ${name}`);
    const statements = method.body.statements;
    let delegated = false;
    if (statements.length === 1 && ts.isReturnStatement(statements[0]) && statements[0].expression && ts.isCallExpression(statements[0].expression)) {
      const call = statements[0].expression;
      let target = call.expression;
      let optional = false;
      function checkOptional(node) {
        if (node.questionDotToken) optional = true;
        ts.forEachChild(node, checkOptional);
      }
      checkOptional(call.expression);
      if (ts.isPropertyAccessExpression(target) && ['call', 'apply'].includes(target.name.text)) target = target.expression;
      const parameters = new Set();
      function bind(name) {
        if (ts.isIdentifier(name)) parameters.add(name.text);
        else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
      }
      for (const parameter of method.parameters) bind(parameter.name);
      const direct = argument => ts.isIdentifier(argument) && (parameters.has(argument.text) || argument.text === 'arguments');
      delegated = !optional && !call.questionDotToken && ts.isPropertyAccessExpression(target) && !target.questionDotToken &&
        ts.isIdentifier(target.expression) && handlers.has(target.expression.text) && !parameters.has(target.expression.text) &&
        call.arguments.length > 0 && call.arguments[0].kind === ts.SyntaxKind.ThisKeyword &&
        call.arguments.slice(1).every(argument => direct(argument) || (ts.isSpreadElement(argument) && direct(argument.expression)));
    }
    if (delegated) {
      forwarding.push(name);
      delegationBodies[name] = tokens(method.getText(source));
    }
    else bodies[name] = crypto.createHash('sha256').update(JSON.stringify(tokens(method.getText(source)))).digest('hex');
  }
  return { handlers: [...handlers].sort(), handlerMethods, handlerContracts, handlerRequiredArguments,
    forwarding: forwarding.sort(), delegationBodies, topLevel, classHeader, bodies };
}

function compact(raw) {
  const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    handlers: raw.handlers,
    forwarding: raw.forwarding,
    delegationBodies: Object.fromEntries(Object.entries(raw.delegationBodies).map(([name, value]) => [name, fingerprint(value)])),
    topLevel: fingerprint(raw.topLevel),
    classHeader: fingerprint(raw.classHeader),
    bodies: raw.bodies
  };
}

function parameterShape(method, source) {
  return method.parameters.map(parameter => tokens(parameter.getText(source)));
}

const PRIOR_UNSUPPORTED_FORWARDING_SHAPES = new Map([
  ['listTopicPublications', ['channelId = null']],
  ['bindingInput', ['binding', 'existing = null']],
  ['bind', ['binding', 'options = {}']],
  ['_bindOrdinary', ['binding', 'identity', 'adoptionCutoff = null', 'options = {}']],
  ['_rebindOrdinary', ['binding', 'identity', 'nativeProof = null', 'intakeCutoff = null', 'options = {}']],
  ['enrollThread', ['input', 'expectedBinding = null']],
  ['listThreadEnrollments', ['parentChannelId = null']],
  ['deactivateThreadEnrollments', ['parentChannelId', 'expectedBinding = null']],
  ['setThreadBaseline', ['threadId', 'latestId', 'expectedBinding = null', 'expectedEnrollment = undefined']],
  ['checkpointThread', ['threadId', 'coverageId', 'expectedBinding = null', 'expectedEnrollment = undefined']],
  ['findNativeBinding', ['nativeId', 'provider = null']],
  ['setBindingReadiness', ['channelId', 'readiness', 'detail = null', 'expectedBinding = null']],
  ['assertNativeOwnerFree', ['provider', 'nativeId', 'channelId = null']],
  ['assertConductorOwnerFree', ['provider', 'conductorId', 'channelId = null']],
  ['upsertIntakeWatermark', ['event', 'ready', 'coverageId = null']],
  ['checkpointIntake', ['channelId', 'coverageId', 'expectedBinding = null']],
  ['setIntakeBaseline', ['channelId', 'lastSeenId', 'detail', 'expectedBinding = null', 'expectedBoundary = undefined', 'expectedReadiness = undefined']],
  ['setIntakeCutoff', ['channelId', 'guildId', 'lastSeenId', 'detail', 'expectedBinding = undefined']],
  ['setIntakeCutoffInTransaction', ['channelId', 'guildId', 'lastSeenId', 'detail', 'expectedBinding = undefined']],
  ['markIntakeBoundary', ['channelId', 'state', 'detail = null', 'gapFrom = null', 'gapTo = null', 'expectedBinding = null', 'pauseMetadata = null', 'expectedBoundary = undefined', 'expectedReadiness = undefined']],
  ['recordTopicPublication', ['channelId', 'publication', 'expectedBinding = null']],
  ['reconcileTopicPublication', ['channelId', 'requestId', 'resolution', 'evidenceScope', 'readback = null']],
  ['acceptInteraction', ['input', 'expectedBinding = null', 'options = {}']],
  ['recordInteractionCallbackOutcome', ['messageId', 'outcome', 'detail = {}']],
  ['recordDecisionPresentationOutcome', ['presentationId', 'outcome', 'messageId = null']],
  ['getTransportReceipt', ['messageId', 'transport = null']],
  ['beginTransportReceipt', ['messageId', 'options = {}']],
  ['recordTransportReceiptOutcome', ['messageId', 'outcome', 'detail = {}', 'transport = null']],
  ['markSubmitted', ['messageId', 'cursor = null', 'marker = null']],
  ['setObserverCursor', ['messageId', 'cursor', 'marker = null']],
  ['releaseNativeReplyFilePreparation', ['messageId', 'preparationId', 'partIndex = 0']],
  ['markReplyFailure', ['messageId', 'error', 'unknown = false', 'partIndex = null']],
  ['reconcileReplyDelivery', ['messageId', 'resolution', 'options = {}']],
  ['recoverAfterRestart', ['ownerAlive = null']],
  ['recoverDirectPostReceipts', ['ownerAlive = undefined']],
  ['recoverDirectPostReceiptsInternal', ['ownerAlive = undefined']],
  ['recoverBoardRefreshReceipts', ['ownerAlive = (pid, identity) => this.directPostOwnerEvidence(pid, identity)']],
  ['recoverBoardRefreshAttempt', ['target', 'attemptId', 'ownerAlive = (pid, identity) => this.directPostOwnerEvidence(pid, identity)']],
  ['recordBoardRefreshOutcome', ['target', 'attemptId', 'outcome', 'detail = {}']],
  ['recordDirectPostPreflight', ['meta', 'outcome', 'detail = {}']],
  ['recordDirectPostOutcome', ['requestId', 'attemptId', 'outcome', 'detail = {}']],
  ['reconcileDirectPostOutcome', ['requestId', 'attemptId', 'resolution', 'evidence = {}']],
  ['recoveryCandidates', ['before = null']],
  ['completeProvisionIntent', ['provider', 'nativeId', 'channelId', 'conductorId = null']]
]);

const PRIOR_UNSUPPORTED_FORWARDING_NAMES = new Set(PRIOR_UNSUPPORTED_FORWARDING_SHAPES.keys());

const PRIOR_SURFACE_METHOD_NAMES = new Set([
  'constructor',
  'bindOrdinary',
  'bindOrdinaryClaude',
  'rebindOrdinary',
  'rebindOrdinaryClaude',
  'isOrdinaryBindingRecord',
  'isOrdinaryBinding',
  'hasOrdinaryPreflight',
  'recordOrdinaryPreflight',
  'findOrdinaryHandoff',
  'handoffOrdinary',
  'transaction',
  '_bindOrdinaryClaude',
  '_rebindOrdinaryClaude',
  '_isOrdinaryBindingRecord',
  '_isOrdinaryBinding',
  '_hasOrdinaryPreflight',
  '_recordOrdinaryPreflight',
  'setThreadBoundaryObserver',
  '_notifyThreadBoundaryTransition',
  '_hasActiveThreadEnrollments',
  'markThreadBoundary',
  'noteThreadMessage',
  '_findOrdinaryHandoff',
  'hasUnresolved',
  'hasDispatching',
  'hasSubmitted',
  'hasUncertain',
  'hasUnresolvedBindingPost',
  'hasUnresolvedOrdinaryPost',
  'reject',
  'listIntakeWatermarks',
  'pauseOrdinaryHandoffIntake',
  'restoreOrdinaryHandoffIntake',
  'recoverInterruptedOrdinaryHandoffIntake',
  'reconcileIntake',
  'acceptDiscordMessage',
  'acceptDecisionInteraction',
  'isInteractionMessage',
  'recoverInteractionCallbacksInTransaction',
  'directPostRows',
  'getBindingReadinessReceipt',
  'listAgentCompletionReceipts',
  'listAgentMessageReceiptIds',
  'releaseDirectPostFilePreparation',
  'directPostOwnerIdentity',
  'directPostOwnerEvidence',
  'directPostOwnerAlive',
  'directPostBindingCurrent',
  'listReceipts',
  'receipt',
  'auditReceipt',
  'failNextIntake',
  'close'
]);

function matches(text, baseline) {
  try {
    const raw = inventory(text);
    const candidate = compact(raw);
    if (Object.keys(candidate.bodies).some(name =>
      !PRIOR_SURFACE_METHOD_NAMES.has(name) && !baseline.forwarding.includes(name))) return false;
    if (JSON.stringify(candidate.handlers) !== JSON.stringify(baseline.handlers) ||
        JSON.stringify(candidate.forwarding) !== JSON.stringify(baseline.forwarding) ||
        JSON.stringify(candidate.topLevel) !== JSON.stringify(baseline.topLevel) ||
        JSON.stringify(candidate.classHeader) !== JSON.stringify(baseline.classHeader) ||
        JSON.stringify(candidate.bodies) !== JSON.stringify(baseline.bodies)) return false;
    for (const name of baseline.forwarding) {
      if (JSON.stringify(candidate.delegationBodies[name]) !== JSON.stringify(baseline.delegationBodies[name])) return false;
    }
    const parsed = ts.createSourceFile('state.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const owner = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SurfaceState');
    const priorUnsupportedForwarding = PRIOR_UNSUPPORTED_FORWARDING_NAMES;
    for (const method of owner.members) {
      const name = ts.isConstructorDeclaration(method) ? 'constructor' : method.name?.text;
      if (!candidate.forwarding.includes(name)) continue;
      if (ts.isConstructorDeclaration(method)) return false;
      const hasUnsupportedModifiers = !!method.modifiers?.length;
      const hasUnsupportedParameters = method.parameters.some(parameter =>
        parameter.initializer || !ts.isIdentifier(parameter.name));
      const exactLegacyParameterShape = JSON.stringify(parameterShape(method, parsed)) ===
        JSON.stringify((PRIOR_UNSUPPORTED_FORWARDING_SHAPES.get(name) || []).map(text => tokens(text)));
      const grandfatheredParameterShape = hasUnsupportedParameters &&
        baseline.forwarding.includes(name) &&
        priorUnsupportedForwarding.has(name) &&
        exactLegacyParameterShape;
      if (hasUnsupportedModifiers || (hasUnsupportedParameters && !grandfatheredParameterShape)) return false;
      const call = method.body.statements[0].expression;
      const dispatch = call.expression;
      if (method.asteriskToken || !ts.isPropertyAccessExpression(dispatch)) return false;
      const target = ['call', 'apply'].includes(dispatch.name.text) ? dispatch.expression : dispatch;
      if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.expression) ||
          !raw.handlerMethods[target.expression.text]?.includes(target.name.text)) return false;
      const style = raw.handlerContracts[target.expression.text]?.[target.name.text];
      const requiredArguments = raw.handlerRequiredArguments[target.expression.text]?.[target.name.text] || 0;
      const parameterNames = method.parameters.map(parameter => parameter.name.text);
      const argumentTexts = call.arguments.slice(1).map(argument => argument.getText(parsed));
      const restApply = dispatch.name.text === 'apply' && method.parameters.length === 1 &&
        !!method.parameters[0].dotDotDotToken && argumentTexts.length === 1 && argumentTexts[0] === parameterNames[0];
      const orderedCall = dispatch.name.text === 'call' && method.parameters.every(parameter => !parameter.dotDotDotToken) &&
        JSON.stringify(argumentTexts) === JSON.stringify(parameterNames);
      const argumentsApply = dispatch.name.text === 'apply' && method.parameters.every(parameter => !parameter.dotDotDotToken) &&
        argumentTexts.length === 1 && argumentTexts[0] === 'arguments';
      const directCall = dispatch.name.text !== 'call' && dispatch.name.text !== 'apply' &&
        call.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword &&
        argumentTexts.length === parameterNames.length &&
        argumentTexts.every((argument, index) => {
          const parameter = method.parameters[index];
          const parameterName = parameter.name.text;
          return parameter.dotDotDotToken ? argument === `...${parameterName}` : argument === parameterName;
        });
      const argumentsSpread = dispatch.name.text !== 'call' && dispatch.name.text !== 'apply' &&
        call.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword &&
        argumentTexts.length === 1 && argumentTexts[0] === '...arguments';
      let matchesStyle = false;
      if (style === INVOCATION_STYLES.THIS) {
        matchesStyle = (restApply || orderedCall || argumentsApply) &&
          (restApply || argumentsApply || method.parameters.length >= requiredArguments);
      }
      else if (style === INVOCATION_STYLES.STATE) {
        matchesStyle = (directCall || argumentsSpread) &&
          (argumentsSpread || method.parameters.some(parameter => parameter.dotDotDotToken) ||
            method.parameters.length >= requiredArguments);
      }
      if (!matchesStyle) return false;
    }
    return true;
  }
  catch { return false; }
}

module.exports = { inventory, compact, matches };
