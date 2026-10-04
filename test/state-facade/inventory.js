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

function collectFactoryMethods(factory) {
  const methods = new Set();
  const collectObject = object => {
    for (const property of object.properties) {
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
  return methods;
}

function factoryMethods(source, factoryName) {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === factoryName) {
      return collectFactoryMethods(statement);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === factoryName &&
          declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        return collectFactoryMethods(declaration.initializer);
      }
    }
  }
  return null;
}

function importedFactoryMethods(source, factoryName) {
  const inline = factoryMethods(source, factoryName);
  if (inline) return inline;
  let modulePath;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !ts.isCallExpression(declaration.initializer) ||
          !ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== 'require' ||
          declaration.initializer.arguments.length !== 1 || !ts.isStringLiteral(declaration.initializer.arguments[0])) continue;
      const binding = declaration.name;
      const importsFactory = ts.isIdentifier(binding) ? binding.text === factoryName :
        ts.isObjectBindingPattern(binding) && binding.elements.some(element =>
          ts.isBindingElement(element) && propertyName(element.propertyName || element.name) === factoryName);
      if (importsFactory) modulePath = declaration.initializer.arguments[0].text;
    }
  }
  if (!modulePath || !modulePath.startsWith('.')) return new Set();
  try {
    const sourcePath = path.resolve(__dirname, '../../src/state.js');
    const importedPath = require.resolve(modulePath, { paths: [path.dirname(sourcePath)] });
    const importedText = fs.readFileSync(importedPath, 'utf8');
    return factoryMethods(ts.createSourceFile(importedPath, importedText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), factoryName) || new Set();
  }
  catch {
    return new Set();
  }
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
    const name = ts.isConstructorDeclaration(method) ? 'constructor' : method.name.getText(source);
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
      const name = method.name?.getText(parsed);
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
      if (!restApply && !orderedCall) return false;
    }
    return true;
  }
  catch { return false; }
}

module.exports = { inventory, compact, matches };
