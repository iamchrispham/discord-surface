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

function collectFactoryMethods(factory, resolveExpression = () => new Set()) {
  const methods = new Set();
  const collectObject = object => {
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        for (const method of resolveExpression(property.expression)) methods.add(method);
        continue;
      }
      const name = propertyName(property.name);
      if (!name) continue;
      if (ts.isMethodDeclaration(property) || ts.isShorthandPropertyAssignment(property)) {
        methods.add(name);
      }
      if (ts.isPropertyAssignment(property) &&
          (ts.isFunctionExpression(property.initializer) || ts.isArrowFunction(property.initializer) ||
           ts.isIdentifier(property.initializer) || ts.isPropertyAccessExpression(property.initializer))) {
        methods.add(name);
      }
    }
  };
  const visit = node => {
    if (ts.isObjectLiteralExpression(node)) collectObject(node);
    if (node !== factory && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(factory);
  const body = factory.body;
  const returns = body && ts.isBlock(body)
    ? body.statements.filter(statement => ts.isReturnStatement(statement)).map(statement => statement.expression).filter(Boolean)
    : [body];
  for (const expression of returns) {
    for (const method of resolveExpression(expression)) methods.add(method);
  }
  return methods;
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
  const target = ts.isCallExpression(expression) ? expression.expression : expression;
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
  if (seen.has(key)) return new Set();
  seen.add(key);
  const factory = factoryDeclaration(source, factoryName);
  if (!factory) return null;
  const bindings = requireBindings(source);
  const resolveExpression = expression => {
    const called = calledFactory(expression);
    if (!called) return new Set();
    const local = factoryMethodsFromSource(source, sourcePath, called.name, seen);
    if (local?.size) return local;
    const binding = called.receiver
      ? (ts.isIdentifier(called.receiver) ? bindings.get(called.receiver.text) : null)
      : bindings.get(called.name);
    const modulePath = directRequire(called.receiver) || binding?.modulePath;
    if (!modulePath) return new Set();
    const importedPath = resolveModulePath(modulePath, sourcePath);
    if (!importedPath) return new Set();
    const importedName = called.receiver && ts.isPropertyAccessExpression(called.receiver)
      ? called.name
      : binding?.exportName || called.name;
    return moduleFactoryMethods(importedPath, importedName, seen);
  };
  return collectFactoryMethods(factory, resolveExpression);
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
    if (!modulePath) return new Set();
    const importedPath = resolveModulePath(modulePath, filePath);
    if (!importedPath) return new Set();
    const importedName = exported && ts.isPropertyAccessExpression(exported)
      ? exported.name.text
      : binding?.exportName || factoryName;
    return moduleFactoryMethods(importedPath, importedName, seen);
  }
  catch {
    return new Set();
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
  const handlerMethods = Object.fromEntries([...handlerFactories].map(([name, factory]) => [name, [...importedFactoryMethods(source, factory)].sort()]));
  const classHeader = tokens(text.slice(owner.getStart(source), owner.members.pos));
  const topLevel = source.statements.filter(node => node !== owner).map(node => tokens(node.getText(source)));
  const bodies = {};
  const delegationBodies = {};
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
  return { handlers: [...handlers].sort(), handlerMethods, forwarding: forwarding.sort(), delegationBodies, topLevel, classHeader, bodies };
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

function matches(text, baseline) {
  try {
    const raw = inventory(text);
    const candidate = compact(raw);
    if (JSON.stringify(candidate.handlers) !== JSON.stringify(baseline.handlers) ||
        JSON.stringify(candidate.topLevel) !== JSON.stringify(baseline.topLevel) ||
        JSON.stringify(candidate.classHeader) !== JSON.stringify(baseline.classHeader) ||
        JSON.stringify(candidate.bodies) !== JSON.stringify(baseline.bodies)) return false;
    for (const name of baseline.forwarding) {
      if (JSON.stringify(candidate.delegationBodies[name]) !== JSON.stringify(baseline.delegationBodies[name])) return false;
    }
    const parsed = ts.createSourceFile('state.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const owner = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SurfaceState');
    for (const method of owner.members) {
      const name = method.name?.text;
      if (!candidate.forwarding.includes(name) || baseline.forwarding.includes(name)) continue;
      if (method.modifiers?.length || method.parameters.some(parameter => parameter.initializer || !ts.isIdentifier(parameter.name))) return false;
      const call = method.body.statements[0].expression;
      const dispatch = call.expression;
      if (method.asteriskToken || !ts.isPropertyAccessExpression(dispatch)) return false;
      const target = ['call', 'apply'].includes(dispatch.name.text) ? dispatch.expression : dispatch;
      if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.expression) ||
          !raw.handlerMethods[target.expression.text]?.includes(target.name.text)) return false;
      const parameterNames = method.parameters.map(parameter => parameter.name.text);
      const argumentTexts = call.arguments.slice(1).map(argument => argument.getText(parsed));
      const restApply = dispatch.name.text === 'apply' && method.parameters.length === 1 &&
        !!method.parameters[0].dotDotDotToken && argumentTexts.length === 1 && argumentTexts[0] === parameterNames[0];
      const orderedCall = dispatch.name.text === 'call' && method.parameters.every(parameter => !parameter.dotDotDotToken) &&
        JSON.stringify(argumentTexts) === JSON.stringify(parameterNames);
      const directCall = dispatch.name.text !== 'call' && dispatch.name.text !== 'apply' &&
        call.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword &&
        argumentTexts.length === parameterNames.length &&
        argumentTexts.every((argument, index) => {
          const parameter = method.parameters[index];
          const parameterName = parameter.name.text;
          return parameter.dotDotDotToken ? argument === `...${parameterName}` : argument === parameterName;
        });
      if (!restApply && !orderedCall && !directCall) return false;
    }
    return true;
  }
  catch { return false; }
}

module.exports = { inventory, compact, matches };
