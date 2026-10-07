const fs = require('node:fs');

const path = require('node:path');

const ts = require('typescript');

const { statementCanFallThrough } = require('./handler-discovery-flow');
const {
  bindingInitializer,
  callableDeclarations,
  declarationForIdentifier,
  factoryDeclaration,
  requireBindings
} = require('./handler-discovery-bindings');
const {
  calledFactory,
  directRequire,
  exportedFactoryExpression,
  reexportedModulePaths
} = require('./handler-discovery-exports');
const { callableDescriptor, collectFactoryMethods } = require('./handler-discovery-contract');

const stateSourcePath = path.resolve(__dirname, '../../src/state.js');

function isAsyncFactory(node) {
  return !!node?.asteriskToken || !!node?.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

function moduleCallableDescriptor(filePath, methodName, seen = new Set()) {
  const key = `${filePath}:${methodName}`;
  if (seen.has(key)) return null;
  seen.add(key);
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const exported = exportedFactoryExpression(source, methodName);
    const exportedName = exported && ts.isIdentifier(exported) ? exported.text : null;
    const local = exportedName ? factoryDeclaration(source, exportedName) : null;
    if (local) return callableDescriptor(local);
    if (!exported) return null;
    const bindings = requireBindings(source);
    const receiverBinding = exported && ts.isPropertyAccessExpression(exported) && ts.isIdentifier(exported.expression)
      ? bindings.get(exported.expression.text, exported.expression)
      : null;
    const binding = (exportedName ? bindings.get(exportedName, exported) : null) || receiverBinding || bindings.get(methodName);
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

function resolveModulePath(modulePath, sourcePath) {
  if (!modulePath?.startsWith('.')) return null;
  try {
    return require.resolve(modulePath, { paths: [path.dirname(sourcePath)] });
  }
  catch {
    return null;
  }
}

function moduleExportsFactory(filePath, factoryName, seen = new Set()) {
  if (seen.has(filePath)) return false;
  seen.add(filePath);
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (exportedFactoryExpression(source, factoryName)) return true;
    return reexportedModulePaths(source).some(modulePath => {
      const importedPath = resolveModulePath(modulePath, filePath);
      return !!(importedPath && moduleExportsFactory(importedPath, factoryName, new Set(seen)));
    });
  }
  catch {
    return false;
  }
}

function moduleFactoryAllowed(filePath, factoryName, seen = new Set(), allowDefault = false) {
  const key = `${filePath}:${factoryName}`;
  if (seen.has(key)) return false;
  seen.add(key);
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const exported = exportedFactoryExpression(source, factoryName, allowDefault);
    const bindings = requireBindings(source);
    if (!exported) {
      for (const modulePath of reexportedModulePaths(source)) {
        const importedPath = resolveModulePath(modulePath, filePath);
        if (importedPath && moduleExportsFactory(importedPath, factoryName)) {
          return moduleFactoryAllowed(importedPath, factoryName, seen, false);
        }
      }
      return false;
    }
    let candidate = exported;
    while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
    const exportedName = ts.isIdentifier(candidate) ? candidate.text : factoryName;
    const local = factoryDeclaration(source, exportedName);
    const factory = local || (ts.isFunctionLike(candidate) ? candidate : null);
    if (factory) {
      return !isAsyncFactory(factory) &&
        (!factory.body || !ts.isBlock(factory.body) || !statementCanFallThrough(factory.body));
    }
    const receiver = ts.isPropertyAccessExpression(candidate) ? candidate.expression : null;
    let binding = null;
    if (ts.isIdentifier(candidate)) binding = bindings.get(candidate.text, candidate);
    else if (receiver && ts.isIdentifier(receiver)) binding = bindings.get(receiver.text, receiver);
    const modulePath = binding?.modulePath || directRequire(receiver) || directRequire(candidate);
    const importedPath = modulePath && resolveModulePath(modulePath, filePath);
    if (!importedPath) return false;
    const importedName = ts.isPropertyAccessExpression(candidate)
      ? candidate.name.text
      : binding?.exportName || factoryName;
    const importedDefault = !ts.isPropertyAccessExpression(candidate) && !binding?.exportName && allowDefault;
    return moduleFactoryAllowed(importedPath, importedName, seen, importedDefault);
  }
  catch {
    return false;
  }
}

function factoryMethodsFromSource(source, sourcePath, factoryName, seen) {
  const key = `${sourcePath}:${factoryName}`;
  if (seen.has(key)) return new Map();
  seen.add(key);
  const factory = factoryDeclaration(source, factoryName);
  if (!factory) return null;
  if (isAsyncFactory(factory)) return null;
  const bindings = requireBindings(source);
  const resolveExpression = expression => {
    const called = calledFactory(expression);
    if (!called) return new Map();
    const local = factoryMethodsFromSource(source, sourcePath, called.name, new Set(seen));
    if (local?.size) return local;
    const binding = called.receiver
      ? (ts.isIdentifier(called.receiver) ? bindings.get(called.receiver.text, called.receiver) : null)
      : bindings.get(called.name, called.target);
    const modulePath = directRequire(called.receiver) || binding?.modulePath;
    if (!modulePath) return new Map();
    const importedPath = resolveModulePath(modulePath, sourcePath);
    if (!importedPath) return new Map();
    const importedName = called.receiver && ts.isPropertyAccessExpression(called.receiver)
      ? called.name
      : binding?.exportName || called.name;
    const allowDefault = !called.receiver && !binding?.exportName;
    return moduleFactoryMethods(importedPath, importedName, new Set(seen), allowDefault);
  };
  const resolveImportedValue = (receiverName, methodName, receiver) => {
    const binding = bindings.get(receiverName, receiver);
    if (!binding) return null;
    const importedPath = resolveModulePath(binding.modulePath, sourcePath);
    return importedPath ? moduleCallableDescriptor(importedPath, methodName) : null;
  };
  return collectFactoryMethods(factory, source, resolveExpression, resolveImportedValue);
}

function moduleFactoryMethods(filePath, factoryName, seen, allowDefault = false) {
  try {
    if (filePath !== stateSourcePath && !moduleFactoryAllowed(filePath, factoryName, new Set(), allowDefault)) return new Map();
    const importedText = fs.readFileSync(filePath, 'utf8');
    const importedSource = ts.createSourceFile(filePath, importedText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const local = factoryMethodsFromSource(importedSource, filePath, factoryName, seen);
    if (local?.size) return local;
    const bindings = requireBindings(importedSource);
    const exported = exportedFactoryExpression(importedSource, factoryName, allowDefault);
    const exportedName = exported && ts.isIdentifier(exported) ? exported.text : null;
    const receiverBinding = exported && ts.isPropertyAccessExpression(exported) && ts.isIdentifier(exported.expression)
      ? bindings.get(exported.expression.text, exported.expression)
      : null;
    const binding = (exportedName ? bindings.get(exportedName, exported) : null) || receiverBinding || bindings.get(factoryName);
    const exportedReceiver = exported && ts.isPropertyAccessExpression(exported) ? exported.expression : null;
    const modulePath = binding?.modulePath || directRequire(exportedReceiver) || directRequire(exported);
    if (modulePath) {
      const importedPath = resolveModulePath(modulePath, filePath);
      if (!importedPath) return new Map();
      const importedName = exported && ts.isPropertyAccessExpression(exported)
        ? exported.name.text
        : binding?.exportName || factoryName;
      const importedDefault = !exported || !ts.isPropertyAccessExpression(exported)
        ? !binding?.exportName && allowDefault
        : false;
      return moduleFactoryMethods(importedPath, importedName, seen, importedDefault);
    }
    for (const reexportPath of reexportedModulePaths(importedSource)) {
      const reexportedPath = resolveModulePath(reexportPath, filePath);
      if (reexportedPath && moduleExportsFactory(reexportedPath, factoryName)) {
        return moduleFactoryMethods(reexportedPath, factoryName, seen);
      }
    }
    return new Map();
  }
  catch {
    return new Map();
  }
}

function returnedExpressions(factory) {
  const body = factory.body;
  if (!body || !ts.isBlock(body)) return body ? [body] : [];
  const expressions = [];
  const visit = node => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      expressions.push(node.expression || null);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return expressions;
}

function factoryResolvesToCompanion(source, sourcePath, factoryName, seen = new Set()) {
  const key = `${sourcePath}:${factoryName}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const bindings = requireBindings(source);
  const factory = factoryDeclaration(source, factoryName);
  if (!factory) {
    const binding = bindings.get(factoryName);
    if (binding?.modulePath) {
      const importedPath = resolveModulePath(binding.modulePath, sourcePath);
      if (importedPath && moduleFactoryAllowed(importedPath, binding.exportName || factoryName, new Set(), !binding.exportName)) return true;
    }
    const exported = exportedFactoryExpression(source, factoryName);
    const exportedReceiver = exported && ts.isPropertyAccessExpression(exported) ? exported.expression : null;
    const importedName = exported && ts.isPropertyAccessExpression(exported)
      ? exported.name.text
      : factoryName;
    const modulePath = directRequire(exportedReceiver) || directRequire(exported);
    if (modulePath) {
      const importedPath = resolveModulePath(modulePath, sourcePath);
      return !!(importedPath && moduleFactoryAllowed(importedPath, importedName, new Set(), false));
    }
    for (const reexportPath of reexportedModulePaths(source)) {
      const importedPath = resolveModulePath(reexportPath, sourcePath);
      if (importedPath && moduleExportsFactory(importedPath, factoryName)) {
        return moduleFactoryAllowed(importedPath, factoryName);
      }
    }
    return false;
  }
  if (isAsyncFactory(factory)) return false;
  if (factory.body && ts.isBlock(factory.body) && statementCanFallThrough(factory.body)) return false;
  const expressions = returnedExpressions(factory);
  if (!expressions.length || expressions.some(expression => !expression)) return false;
  return expressions.every(expression => {
    const called = calledFactory(expression, true);
    if (!called) return false;
    const binding = called.receiver && ts.isIdentifier(called.receiver)
      ? bindings.get(called.receiver.text, called.receiver)
      : bindings.get(called.name, called.target);
    const modulePath = directRequire(called.receiver) || binding?.modulePath;
    if (modulePath) {
      const importedPath = resolveModulePath(modulePath, sourcePath);
      const importedName = called.receiver && ts.isPropertyAccessExpression(called.receiver)
        ? called.name
        : binding?.exportName || called.name;
      const allowDefault = !called.receiver && !binding?.exportName;
      if (importedPath && moduleFactoryAllowed(importedPath, importedName, new Set(), allowDefault)) return true;
    }
    return factoryDeclaration(source, called.name) &&
      factoryResolvesToCompanion(source, sourcePath, called.name, new Set(seen));
  });
}

function factoryMethods(source, factoryName) {
  const sourcePath = path.isAbsolute(source.fileName) ? source.fileName : stateSourcePath;
  const methods = factoryMethodsFromSource(source, sourcePath, factoryName, new Set());
  return methods?.size ? methods : null;
}

function importedFactoryMethods(source, factoryName) {
  const sourcePath = path.isAbsolute(source.fileName) ? source.fileName : stateSourcePath;
  if (!factoryResolvesToCompanion(source, sourcePath, factoryName)) return null;
  const local = factoryMethods(source, factoryName);
  if (local) return local;
  const imported = moduleFactoryMethods(sourcePath, factoryName, new Set());
  return imported.size ? imported : null;
}

function discoverFactory(source, factoryName) {
  const methods = importedFactoryMethods(source, factoryName);
  return { methods: methods || new Map(), approved: methods !== null };
}

module.exports = { discoverFactory };
