'use strict';

const path = require('node:path');
const ts = require('typescript');

const MODULE_OBJECT_PREFIX = 'local-module:';
const PROCESS_OBJECT = 'process-object';
const PID_PROBE = 'pid-probe';
const LEGACY_OWNER = 'legacy-owner';

const unwrap = node => {
  let current = node;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current) || ts.isAwaitExpression(current))) current = current.expression;
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
    const extension = path.extname(base);
    const stem = extension && ['.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx'].includes(extension)
      ? base.slice(0, -extension.length) : base;
    const candidates = [base, stem, `${stem}.js`, `${stem}.ts`, `${stem}.tsx`, `${stem}.cjs`, `${stem}.mjs`,
      path.join(stem, 'index.js'), path.join(stem, 'index.ts')];
    return candidates.find(candidate => moduleByPath.has(path.resolve(candidate))) || null;
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
      defaultExport: null,
      exportEquals: null,
      wildcardExports: [],
      exportAliases: new Set(['exports'])
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
    const isExportObjectExpression = expression => {
      const node = unwrap(expression);
      if (!node) return false;
      if (ts.isIdentifier(node)) return module.exportAliases.has(node.text);
      if (ts.isPropertyAccessExpression(node)) {
        return node.name.text === 'exports' && ts.isIdentifier(node.expression) &&
          node.expression.text === 'module';
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const name = unwrap(node.argumentExpression);
        return node.expression.text === 'module' &&
          (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) && name.text === 'exports';
      }
      return false;
    };
    const recordExportAlias = (name, expression) => {
      if (!name) return;
      if (isExportObjectExpression(expression)) module.exportAliases.add(name);
      else module.exportAliases.delete(name);
    };
    const recordVariable = (declaration, exported = false) => {
      if (ts.isIdentifier(declaration.name)) {
        addBinding(declaration.name.text, declaration.initializer);
        recordExportAlias(declaration.name.text, declaration.initializer);
        if (exported) {
          // Exported bindings are live. Resolve through every recorded value,
          // including later assignments, instead of freezing the initializer.
          addExport(declaration.name.text, { binding: declaration.name.text });
        }
        return;
      }
      if (!declaration.initializer || !ts.isObjectBindingPattern(declaration.name)) return;
      for (const element of declaration.name.elements) {
        if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
        const name = element.propertyName && (ts.isIdentifier(element.propertyName) ||
          ts.isStringLiteral(element.propertyName)) ? element.propertyName.text : element.name.text;
        addBinding(element.name.text, { base: declaration.initializer, name });
        if (exported) addExport(element.name.text, { binding: element.name.text });
      }
    };
    const recordFunction = (declaration, exported = false) => {
      const isDefault = declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (!declaration.name) {
        if (exported && isDefault) {
          module.defaultExport = declaration;
        }
        return;
      }
      addBinding(declaration.name.text, declaration);
      if (exported && !isDefault) addExport(declaration.name.text, { binding: declaration.name.text });
      if (isDefault) {
        module.defaultExport = declaration;
      }
    };
    const recordClass = (declaration, exported = false) => {
      const isDefault = declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (!declaration.name) {
        if (exported && isDefault) module.defaultExport = declaration;
        return;
      }
      addBinding(declaration.name.text, declaration);
      if (exported && !isDefault) addExport(declaration.name.text, { binding: declaration.name.text });
      if (isDefault) module.defaultExport = declaration;
    };
    const recordImport = declaration => {
      if (!ts.isStringLiteral(declaration.moduleSpecifier)) return;
      const specifier = declaration.moduleSpecifier.text;
      if (specifier === 'node:process' || specifier === 'process') {
        const clause = declaration.importClause;
        if (clause?.name) module.imports.set(clause.name.text, { builtin: specifier, name: 'default' });
        if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          module.imports.set(clause.namedBindings.name.text, { builtin: specifier, name: '*' });
        }
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const specifierNode of clause.namedBindings.elements) {
            const imported = specifierNode.propertyName || specifierNode.name;
            module.imports.set(specifierNode.name.text, { builtin: specifier, name: imported.text });
          }
        }
        return;
      }
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
      if (reference.expression.text === 'node:process' || reference.expression.text === 'process') {
        module.imports.set(declaration.name.text, { builtin: reference.expression.text, name: '*' });
        return;
      }
      const modulePath = resolveRequest(resolvedPath, reference.expression.text);
      if (modulePath) module.imports.set(declaration.name.text, { modulePath, name: '*' });
    };
    const recordAssignment = expression => {
      if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
      const left = unwrap(expression.left);
      if (ts.isIdentifier(left)) {
        addBinding(left.text, expression.right);
        recordExportAlias(left.text, expression.right);
      }
      const name = propertyName(left);
      if (!name || !ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return;
      const receiver = left.expression;
      if (isExportObjectExpression(receiver)) addExport(name, expression.right);
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'exports' &&
        ts.isIdentifier(left.expression) && left.expression.text === 'module') {
        module.defaultExport = expression.right;
        module.exportEquals = expression.right;
      }
      if (ts.isElementAccessExpression(left) && name === 'exports' && ts.isIdentifier(left.expression) &&
        left.expression.text === 'module') {
        module.defaultExport = expression.right;
        module.exportEquals = expression.right;
      }
    };
    const recordExportExpression = expression => {
      if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isBinaryExpression(expression.right)) {
        recordExportExpression(expression.right);
      }
      const left = unwrap(expression.left);
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'exports' &&
        ts.isIdentifier(left.expression) && left.expression.text === 'module') {
        module.defaultExport = expression.right;
        module.exportEquals = expression.right;
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
    const recordExportAssignment = statement => {
      if (statement.isExportEquals) {
        module.exportEquals = statement.expression;
        module.defaultExport = statement.expression;
      }
    };
    const scanModuleLevel = node => {
      if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
        ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
      if (ts.isBinaryExpression(node)) recordAssignment(node);
      ts.forEachChild(node, scanModuleLevel);
    };

    for (const statement of sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) recordImport(statement);
      if (ts.isImportEqualsDeclaration(statement)) recordImportEquals(statement);
      if (ts.isVariableStatement(statement)) {
        const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        for (const declaration of statement.declarationList.declarations) recordVariable(declaration, exported);
      }
      if (ts.isFunctionDeclaration(statement)) {
        const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        recordFunction(statement, exported);
      }
      if (ts.isClassDeclaration(statement)) {
        const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
        recordClass(statement, exported);
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
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause) && modulePath) {
          const exported = statement.exportClause.name.text;
          addBinding(exported, { namespaceModulePath: modulePath });
          addExport(exported, { binding: exported });
        } else if (modulePath) {
          module.wildcardExports.push(modulePath);
        }
      }
      if (ts.isExportAssignment(statement)) {
        recordExportAssignment(statement);
        if (!statement.isExportEquals) {
          const snapshotBindings = new Map();
          for (const [name, bindings] of module.bindings) snapshotBindings.set(name, bindings.slice());
          addExport('default', {
            snapshotExpression: statement.expression,
            snapshotBindings
          });
        }
      }
      if (ts.isExpressionStatement(statement)) {
        const expression = unwrap(statement.expression);
        if (ts.isBinaryExpression(expression)) recordExportExpression(expression);
      }
    }
    scanModuleLevel(sourceFile);
    return module;
  };

  const evaluateProperty = (expression, name, currentPath, visited, bindingOverrides = new Map()) => {
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
          ? property.name.text
          : ts.isComputedPropertyName(property.name)
            ? staticPropertyValue(property.name.expression, currentPath, seen)
            : null;
        if (key !== name) continue;
        const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
        for (const atom of evaluate(value, currentPath, seen, new Map(), bindingOverrides)) result.add(atom);
      }
      return result;
    }
    if (ts.isIdentifier(node)) {
      const module = currentPath && modules.get(currentPath);
      const bindings = module?.bindings.get(node.text) || [];
      const result = new Set();
      for (const binding of bindings) {
        if (binding && binding.base) {
          for (const atom of evaluateProperty(binding.base, name, currentPath, seen, bindingOverrides)) result.add(atom);
        } else {
          for (const atom of evaluateProperty(binding, name, currentPath, seen, bindingOverrides)) result.add(atom);
        }
      }
      return result;
    }
    const atoms = evaluate(node, currentPath, seen, new Map(), bindingOverrides);
    const result = new Set();
    for (const atom of atoms) {
      const modulePath = modulePathFromAtom(atom);
      if (modulePath) for (const nested of resolveExport(modulePath, name, seen)) result.add(nested);
    }
    return result;
  };

  const staticPropertyValue = (expression, currentPath, visited = new Set()) => {
    const node = unwrap(expression);
    if (!node || visited.has(node)) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return node.text;
    if (!ts.isIdentifier(node)) return null;
    const module = currentPath && modules.get(currentPath);
    for (const binding of module?.bindings.get(node.text) || []) {
      const value = staticPropertyValue(binding, currentPath, new Set(visited).add(node));
      if (value !== null) return value;
    }
    return null;
  };

  const callableReturnExpressions = callable => {
    const body = callable.body;
    if (!body) return [];
    if (!ts.isBlock(body)) return [body];
    const returns = [];
    const visit = node => {
      if (ts.isReturnStatement(node)) {
        if (node.expression) returns.push(node.expression);
        return;
      }
      if (ts.isFunctionLike(node) && node !== callable) return;
      ts.forEachChild(node, visit);
    };
    visit(body);
    return returns;
  };

  const classPropertyExpressions = (declaration, name, staticMember) => {
    const expressions = [];
    for (const member of declaration.members || []) {
      if (!member.name) continue;
      const memberName = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ||
        ts.isNumericLiteral(member.name) ? member.name.text : null;
      if (memberName !== String(name)) continue;
      const isStatic = member.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) || false;
      if (isStatic !== staticMember) continue;
      if (ts.isPropertyDeclaration(member) && member.initializer) expressions.push(member.initializer);
      else if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) expressions.push(member);
    }
    return expressions;
  };

  const resolveClassProperty = (atom, name, currentPath, visited) => {
    if (!atom?.classDeclaration) return new Set();
    const result = new Set();
    for (const expression of classPropertyExpressions(atom.classDeclaration, name, !atom.instance)) {
      if (ts.isGetAccessorDeclaration(expression)) {
        for (const returnExpression of callableReturnExpressions(expression)) {
          for (const nested of evaluate(returnExpression, atom.modulePath || currentPath, visited)) result.add(nested);
        }
      } else if (ts.isMethodDeclaration(expression)) {
        result.add({ callable: expression, modulePath: atom.modulePath || currentPath });
      } else {
        for (const nested of evaluate(expression, atom.modulePath || currentPath, visited)) result.add(nested);
      }
    }
    return result;
  };

  const resolveProperty = (atoms, name, currentPath, visited = new Set()) => {
    const result = new Set();
    for (const atom of atoms || []) {
      const modulePath = modulePathFromAtom(atom);
      if (modulePath) {
        for (const nested of resolveExport(modulePath, String(name), visited)) result.add(nested);
      } else {
        for (const nested of resolveClassProperty(atom, name, currentPath, visited)) result.add(nested);
      }
    }
    return result;
  };

  const resolveNew = atoms => {
    const result = new Set();
    for (const atom of atoms || []) {
      if (atom?.classDeclaration) result.add({
        classDeclaration: atom.classDeclaration,
        modulePath: atom.modulePath,
        instance: true
      });
    }
    return result;
  };

  const callableParameterBindings = (callable, argumentsList, callerPath) => {
    const bindings = new Map();
    for (let index = 0; index < (callable.parameters || []).length; index += 1) {
      const parameter = callable.parameters[index];
      const suppliedArgument = argumentsList === null ? undefined : argumentsList?.[index];
      const argument = suppliedArgument ?? parameter.initializer;
      if (!argument) continue;
      if (ts.isIdentifier(parameter.name)) {
        bindings.set(parameter.name.text, { expression: argument, currentPath: callerPath });
        continue;
      }
      if (ts.isObjectBindingPattern(parameter.name)) {
        for (const element of parameter.name.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          const property = element.propertyName && (ts.isIdentifier(element.propertyName) ||
            ts.isStringLiteral(element.propertyName)) ? element.propertyName.text : element.name.text;
          bindings.set(element.name.text, { expression: argument, name: property, currentPath: callerPath });
        }
      }
    }
    return bindings;
  };

  const localBindingSources = (node, name) => {
    let current = node.parent;
    let functionScope = null;
    while (current && !ts.isSourceFile(current)) {
      if (ts.isFunctionLike(current)) {
        functionScope = current;
        break;
      }
      current = current.parent;
    }
    if (!functionScope) return null;
    const scopes = [];
    current = node.parent;
    while (current && current !== functionScope) {
      if (ts.isBlock(current)) scopes.push(current);
      current = current.parent;
    }
    if (functionScope.body && ts.isBlock(functionScope.body)) scopes.push(functionScope.body);
    for (const scope of scopes) {
      const sources = [];
      let found = false;
      const collect = child => {
        if (child !== scope && (ts.isBlock(child) || ts.isFunctionLike(child) ||
          ts.isClassDeclaration(child) || ts.isClassExpression(child))) return;
        if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === name) {
          found = true;
          if (child.initializer) sources.push(child.initializer);
        }
        ts.forEachChild(child, collect);
      };
      collect(scope);
      if (scope === functionScope.body) {
        for (const parameter of functionScope.parameters || []) {
          if (!ts.isIdentifier(parameter.name) || parameter.name.text !== name) continue;
          found = true;
          if (parameter.initializer) sources.push(parameter.initializer);
        }
      }
      if (found) return { sources };
    }
    return null;
  };

  const evaluate = (expression, currentPath, visited = new Set(), parameterBindings = new Map(),
    bindingOverrides = new Map()) => {
    if (expression?.namespaceModulePath) return new Set([moduleAtom(expression.namespaceModulePath)]);
    if (expression?.snapshotExpression) {
      const overrides = new Map(bindingOverrides);
      overrides.set(currentPath, expression.snapshotBindings);
      return evaluate(expression.snapshotExpression, currentPath, visited, parameterBindings, overrides);
    }
    const node = unwrap(expression);
    if (!node || visited.has(node)) return new Set();
    const seen = new Set(visited).add(node);
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      return new Set([{ classDeclaration: node, modulePath: currentPath, instance: false }]);
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      return new Set([{ callable: node, modulePath: currentPath }]);
    }
    if (ts.isMethodDeclaration(node)) {
      return new Set([{ callable: node, modulePath: currentPath }]);
    }
    if (ts.isConditionalExpression(node)) {
      const result = evaluate(node.whenTrue, currentPath, seen, parameterBindings, bindingOverrides);
      for (const atom of evaluate(node.whenFalse, currentPath, seen, parameterBindings, bindingOverrides)) {
        result.add(atom);
      }
      return result;
    }
    if (ts.isIdentifier(node)) {
      const parameter = parameterBindings.get(node.text);
      if (parameter) {
        if (parameter.name) {
          return evaluateProperty(parameter.expression, parameter.name, parameter.currentPath, seen, bindingOverrides);
        }
        return evaluate(parameter.expression, parameter.currentPath, seen, parameter.bindings || new Map(), bindingOverrides);
      }
      const localBinding = localBindingSources(node, node.text);
      if (localBinding) {
        const result = new Set();
        for (const source of localBinding.sources) {
          for (const atom of evaluate(source, currentPath, seen, parameterBindings, bindingOverrides)) result.add(atom);
        }
        return result;
      }
      const module = currentPath && scanModule(currentPath);
      const imported = module?.imports.get(node.text);
      if (imported) {
        if (imported.builtin === 'node:process' || imported.builtin === 'process') {
          return imported.name === 'kill' ? new Set([PID_PROBE]) : new Set([PROCESS_OBJECT]);
        }
        return resolveExport(imported.modulePath, imported.name, seen);
      }
      const bindings = bindingOverrides.has(currentPath) && bindingOverrides.get(currentPath).has(node.text)
        ? bindingOverrides.get(currentPath).get(node.text)
        : module?.bindings.get(node.text) || [];
      const result = new Set();
      for (const binding of bindings) {
        if (binding && binding.base) {
          for (const atom of evaluateProperty(binding.base, binding.name, currentPath, seen, bindingOverrides)) result.add(atom);
        } else {
          for (const atom of evaluate(binding, currentPath, seen, parameterBindings, bindingOverrides)) result.add(atom);
        }
      }
      if (module?.bindings.has(node.text)) return result;
      if (result.size) return result;
      if (node.text === 'process') return new Set([PROCESS_OBJECT]);
      return result;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = propertyName(node) || (ts.isElementAccessExpression(node)
        ? staticPropertyValue(node.argumentExpression, currentPath, seen) : null);
      if (!name) return new Set();
      const receiver = evaluate(node.expression, currentPath, seen, parameterBindings, bindingOverrides);
      const result = new Set();
      if (name === 'directPostOwnerAlive') result.add(LEGACY_OWNER);
      if (name === 'kill' && receiver.has(PROCESS_OBJECT)) result.add(PID_PROBE);
      for (const atom of receiver) {
        for (const nested of resolveProperty([atom], String(name), currentPath, seen)) result.add(nested);
      }
      return result;
    }
    if (ts.isNewExpression(node)) return resolveNew(evaluate(node.expression, currentPath, seen, parameterBindings));
    if (ts.isCallExpression(node)) {
      const callableAtoms = evaluate(node.expression, currentPath, seen, parameterBindings);
      const result = new Set();
      for (const atom of callableAtoms) {
        if (!atom || !atom.callable) continue;
        const callablePath = atom.modulePath || currentPath;
        const nestedBindings = callableParameterBindings(atom.callable, node.arguments || [], currentPath);
        for (const returnExpression of callableReturnExpressions(atom.callable)) {
          for (const returnAtom of evaluate(returnExpression, callablePath, seen, nestedBindings)) result.add(returnAtom);
        }
      }
      if (result.size) return result;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' &&
      ts.isStringLiteral(node.arguments[0])) {
      const currentModule = currentPath && scanModule(currentPath);
      if (currentModule?.bindings.has('require')) return new Set();
      const specifier = node.arguments[0].text;
      if (specifier === 'node:process' || specifier === 'process') return new Set([PROCESS_OBJECT]);
      const modulePath = currentPath && resolveRequest(currentPath, specifier);
      if (!modulePath) return new Set();
      const result = new Set([moduleAtom(modulePath)]);
      const module = scanModule(modulePath);
      if (module.defaultExport) {
        for (const atom of evaluate(module.defaultExport, modulePath, seen)) result.add(atom);
      }
      return result;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return evaluate(node.right, currentPath, seen, parameterBindings, bindingOverrides);
    }
    return new Set();
  };

  const resolveExportEquals = modulePath => {
    const module = scanModule(modulePath);
    if (!module) return new Set();
    const result = new Set();
    const expression = module.exportEquals;
    if (expression) {
      for (const atom of evaluate(expression, module.path, new Set())) result.add(atom);
    }
    return result;
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
    if (!values.length) {
      for (const wildcardPath of module.wildcardExports || []) {
        for (const atom of resolveExport(wildcardPath, name, seen)) result.add(atom);
      }
    }
    return result;
  };

  const evaluateBinding = (name, currentPath, visited) => {
    const module = scanModule(currentPath);
    const imported = module?.imports.get(name);
    if (imported) {
      if (imported.builtin === 'node:process' || imported.builtin === 'process') {
        return imported.name === 'kill' ? new Set([PID_PROBE]) : new Set([PROCESS_OBJECT]);
      }
      return resolveExport(imported.modulePath, imported.name, visited);
    }
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
    resolveImport(fromPath, specifier, name, options = {}) {
      const modulePath = resolveRequest(fromPath, specifier);
      if (!modulePath) return new Set();
      return options.importEquals ? resolveExportEquals(modulePath) : resolveExport(modulePath, name);
    },
    resolveRequire(fromPath, specifier) {
      const modulePath = resolveRequest(fromPath, specifier);
      if (!modulePath) return new Set();
      const result = new Set([moduleAtom(modulePath)]);
      const module = scanModule(modulePath);
      if (module.defaultExport) {
        for (const atom of evaluate(module.defaultExport, modulePath, new Set())) result.add(atom);
      }
      return result;
    },
    resolveCall(atoms, argumentsList = [], callerPath = null, visited = new Set()) {
      if (argumentsList instanceof Set) {
        visited = argumentsList;
        argumentsList = [];
      }
      const result = new Set();
      for (const atom of atoms || []) {
        if (!atom || !atom.callable) continue;
        const callablePath = atom.modulePath || callerPath;
        const parameterBindings = callableParameterBindings(atom.callable, argumentsList, callerPath);
        for (const returnExpression of callableReturnExpressions(atom.callable)) {
          for (const returnAtom of evaluate(returnExpression, callablePath, visited, parameterBindings)) result.add(returnAtom);
        }
      }
      return result;
    },
    resolveExport,
    resolveProperty,
    resolveNew,
    modulePathFromAtom,
    moduleAtom
  };
}

module.exports = { createLocalModuleResolver, MODULE_OBJECT_PREFIX };
