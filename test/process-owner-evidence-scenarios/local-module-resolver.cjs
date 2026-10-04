'use strict';

const path = require('node:path');
const ts = require('typescript');

const MODULE_OBJECT_PREFIX = 'local-module:';
const PROCESS_OBJECT = 'process-object';
const PID_PROBE = 'pid-probe';

const unwrap = node => {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current))) current = current.expression;
  return current;
};

const propertyName = node => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node)) return null;
  const argument = unwrap(node.argumentExpression);
  return ts.isStringLiteral(argument) || ts.isNumericLiteral(argument) ? argument.text : null;
};

const isRelative = specifier => specifier.startsWith('./') || specifier.startsWith('../');

function createLocalModuleResolver(files) {
  const modules = new Map();
  const moduleByPath = new Map(files.map(fullPath => [path.resolve(fullPath), null]));

  const resolveRequest = (fromPath, specifier) => {
    if (!isRelative(specifier)) return null;
    const base = path.resolve(path.dirname(fromPath), specifier);
    const candidates = [base, `${base}.js`, `${base}.ts`, `${base}.cjs`, `${base}.mjs`,
      path.join(base, 'index.js'), path.join(base, 'index.ts')];
    return candidates.find(candidate => moduleByPath.has(candidate)) || null;
  };

  const moduleAtom = modulePath => `${MODULE_OBJECT_PREFIX}${modulePath}`;
  const modulePathFromAtom = atom => typeof atom === 'string' && atom.startsWith(MODULE_OBJECT_PREFIX)
    ? atom.slice(MODULE_OBJECT_PREFIX.length) : null;

  const scanModule = fullPath => {
    const resolvedPath = path.resolve(fullPath);
    if (modules.has(resolvedPath)) return modules.get(resolvedPath);
    const text = require('node:fs').readFileSync(resolvedPath, 'utf8');
    const kind = resolvedPath.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const sourceFile = ts.createSourceFile(resolvedPath, text, ts.ScriptTarget.Latest, true, kind);
    const module = {
      path: resolvedPath,
      bindings: new Map(),
      imports: new Map(),
      exports: new Map(),
      defaultExport: null
    };
    modules.set(resolvedPath, module);

    const addBinding = (name, expression) => {
      if (!name || !expression) return;
      const existing = module.bindings.get(name);
      if (existing) existing.push(expression);
      else module.bindings.set(name, [expression]);
    };
    const addExport = (name, value) => {
      if (!name || !value) return;
      const existing = module.exports.get(name);
      if (existing) existing.push(value);
      else module.exports.set(name, [value]);
    };
    const recordVariable = (declaration, exported = false) => {
      if (ts.isIdentifier(declaration.name)) {
        addBinding(declaration.name.text, declaration.initializer);
        if (exported) {
          addExport(declaration.name.text, declaration.initializer);
        }
        return;
      }
      if (!declaration.initializer || !ts.isObjectBindingPattern(declaration.name)) return;
      for (const element of declaration.name.elements) {
        if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
        const name = element.propertyName && (ts.isIdentifier(element.propertyName) ||
          ts.isStringLiteral(element.propertyName)) ? element.propertyName.text : element.name.text;
        addBinding(element.name.text, { base: declaration.initializer, name });
      }
    };
    const recordImport = declaration => {
      if (!ts.isStringLiteral(declaration.moduleSpecifier)) return;
      const modulePath = resolveRequest(resolvedPath, declaration.moduleSpecifier.text);
      if (!modulePath) return;
      const clause = declaration.importClause;
      if (clause?.name) module.imports.set(clause.name.text, { modulePath, name: 'default' });
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        module.imports.set(clause.namedBindings.name.text, { modulePath, name: '*' });
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const specifier of clause.namedBindings.elements) {
          const imported = specifier.propertyName || specifier.name;
          module.imports.set(specifier.name.text, { modulePath, name: imported.text });
        }
      }
    };
    const recordImportEquals = declaration => {
      const reference = declaration.moduleReference;
      if (!ts.isExternalModuleReference(reference) || !ts.isStringLiteral(reference.expression)) return;
      const modulePath = resolveRequest(resolvedPath, reference.expression.text);
      if (modulePath) module.imports.set(declaration.name.text, { modulePath, name: '*' });
    };
    const recordAssignment = expression => {
      if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
      const left = unwrap(expression.left);
      if (ts.isIdentifier(left)) addBinding(left.text, expression.right);
      const name = propertyName(left);
      if (!name || !ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return;
      const receiver = left.expression;
      if (ts.isIdentifier(receiver) && receiver.text === 'exports') addExport(name, expression.right);
      if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'exports' &&
        ts.isIdentifier(receiver.expression) && receiver.expression.text === 'module') {
        addExport(name, expression.right);
      }
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'exports' &&
        ts.isIdentifier(left.expression) && left.expression.text === 'module') {
        module.defaultExport = expression.right;
      }
      if (ts.isElementAccessExpression(left) && name === 'exports' && ts.isIdentifier(left.expression) &&
        left.expression.text === 'module') module.defaultExport = expression.right;
    };
    const recordExportExpression = expression => {
      const left = unwrap(expression.left);
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'exports' &&
        ts.isIdentifier(left.expression) && left.expression.text === 'module') {
        module.defaultExport = expression.right;
        if (ts.isObjectLiteralExpression(expression.right)) {
          for (const property of expression.right.properties) {
            if (!property.name || (!ts.isPropertyAssignment(property) &&
              !ts.isShorthandPropertyAssignment(property))) continue;
            const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
              ? property.name.text : null;
            const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
            addExport(name, value);
          }
        }
      }
      recordAssignment(expression);
    };

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) recordImport(statement);
      if (ts.isImportEqualsDeclaration(statement)) recordImportEquals(statement);
      if (ts.isVariableStatement(statement)) {
        const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        for (const declaration of statement.declarationList.declarations) recordVariable(declaration, exported);
      }
      if (ts.isExportDeclaration(statement)) {
        const moduleSpecifier = statement.moduleSpecifier;
        const modulePath = moduleSpecifier && ts.isStringLiteral(moduleSpecifier)
          ? resolveRequest(resolvedPath, moduleSpecifier.text) : null;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const specifier of statement.exportClause.elements) {
            const exported = specifier.name.text;
            const imported = (specifier.propertyName || specifier.name).text;
            if (modulePath) addExport(exported, { modulePath, name: imported });
            else addExport(exported, { binding: imported });
          }
        }
      }
      if (ts.isExportAssignment(statement)) {
        if (statement.isExportEquals) module.defaultExport = statement.expression;
        else addExport('default', statement.expression);
      }
      if (ts.isExpressionStatement(statement)) {
        const expression = unwrap(statement.expression);
        if (ts.isBinaryExpression(expression)) recordExportExpression(expression);
      }
    }
    return module;
  };

  const evaluateProperty = (expression, name, currentPath, visited) => {
    const node = unwrap(expression);
    if (!node || visited.has(node)) return new Set();
    const seen = new Set(visited).add(node);
    if (ts.isObjectLiteralExpression(node)) {
      const result = new Set();
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) {
          for (const atom of evaluateProperty(property.expression, name, currentPath, seen)) result.add(atom);
          continue;
        }
        if (!property.name || (!ts.isPropertyAssignment(property) &&
          !ts.isShorthandPropertyAssignment(property))) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text : null;
        if (key !== name) continue;
        const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
        for (const atom of evaluate(value, currentPath, seen)) result.add(atom);
      }
      return result;
    }
    if (ts.isIdentifier(node)) {
      const module = currentPath && modules.get(currentPath);
      const bindings = module?.bindings.get(node.text) || [];
      const result = new Set();
      for (const binding of bindings) {
        if (binding && binding.base) {
          for (const atom of evaluateProperty(binding.base, name, currentPath, seen)) result.add(atom);
        }
      }
      return result;
    }
    const atoms = evaluate(node, currentPath, seen);
    const result = new Set();
    for (const atom of atoms) {
      const modulePath = modulePathFromAtom(atom);
      if (modulePath) for (const nested of resolveExport(modulePath, name, seen)) result.add(nested);
    }
    return result;
  };

  const evaluate = (expression, currentPath, visited = new Set()) => {
    const node = unwrap(expression);
    if (!node || visited.has(node)) return new Set();
    const seen = new Set(visited).add(node);
    if (ts.isIdentifier(node)) {
      if (node.text === 'process') return new Set([PROCESS_OBJECT]);
      const module = currentPath && scanModule(currentPath);
      const imported = module?.imports.get(node.text);
      if (imported) return resolveExport(imported.modulePath, imported.name, seen);
      const bindings = module?.bindings.get(node.text) || [];
      const result = new Set();
      for (const binding of bindings) {
        if (binding && binding.base) {
          for (const atom of evaluateProperty(binding.base, binding.name, currentPath, seen)) result.add(atom);
        } else {
          for (const atom of evaluate(binding, currentPath, seen)) result.add(atom);
        }
      }
      return result;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = propertyName(node);
      if (!name) return new Set();
      const receiver = evaluate(node.expression, currentPath, seen);
      const result = new Set();
      if (name === 'kill' && receiver.has(PROCESS_OBJECT)) result.add(PID_PROBE);
      for (const atom of receiver) {
        const modulePath = modulePathFromAtom(atom);
        if (modulePath) for (const nested of resolveExport(modulePath, String(name), seen)) result.add(nested);
      }
      return result;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' &&
      ts.isStringLiteral(node.arguments[0])) {
      const modulePath = currentPath && resolveRequest(currentPath, node.arguments[0].text);
      return modulePath ? new Set([moduleAtom(modulePath)]) : new Set();
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return evaluate(node.right, currentPath, seen);
    }
    return new Set();
  };

  const resolveExport = (modulePath, name, visited = new Set()) => {
    const module = scanModule(modulePath);
    if (!module || name === '*') return name === '*' && module ? new Set([moduleAtom(module.path)]) : new Set();
    const marker = `${module.path}\u0000${name}`;
    if (visited.has(marker)) return new Set();
    const seen = new Set(visited).add(marker);
    const values = module.exports.get(name) || [];
    const result = new Set();
    for (const value of values) {
      if (value && value.modulePath) {
        for (const atom of resolveExport(value.modulePath, value.name, seen)) result.add(atom);
      } else if (value && value.binding) {
        for (const atom of evaluateBinding(value.binding, module.path, seen)) result.add(atom);
      } else {
        for (const atom of evaluate(value, module.path, seen)) result.add(atom);
      }
    }
    if (!values.length && name !== 'default' && module.defaultExport) {
      for (const atom of evaluateProperty(module.defaultExport, name, module.path, seen)) result.add(atom);
    }
    if (name === 'default' && module.defaultExport) {
      for (const atom of evaluate(module.defaultExport, module.path, seen)) result.add(atom);
    }
    return result;
  };

  const evaluateBinding = (name, currentPath, visited) => {
    const module = scanModule(currentPath);
    const bindings = module?.bindings.get(name) || [];
    const result = new Set();
    for (const binding of bindings) {
      if (binding && binding.base) {
        for (const atom of evaluateProperty(binding.base, binding.name, currentPath, visited)) result.add(atom);
      } else {
        for (const atom of evaluate(binding, currentPath, visited)) result.add(atom);
      }
    }
    return result;
  };

  for (const fullPath of files) scanModule(fullPath);
  return {
    resolveImport(fromPath, specifier, name) {
      const modulePath = resolveRequest(fromPath, specifier);
      return modulePath ? resolveExport(modulePath, name) : new Set();
    },
    resolveRequire(fromPath, specifier) {
      const modulePath = resolveRequest(fromPath, specifier);
      return modulePath ? new Set([moduleAtom(modulePath)]) : new Set();
    },
    resolveExport,
    modulePathFromAtom,
    moduleAtom
  };
}

module.exports = { createLocalModuleResolver, MODULE_OBJECT_PREFIX };
