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

const propertyName = (node, resolveIdentifier) => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node)) return null;
  const argument = unwrap(node.argumentExpression);
  if (ts.isStringLiteral(argument) || ts.isNumericLiteral(argument)) return argument.text;
  return ts.isIdentifier(argument) ? resolveIdentifier?.(argument) ?? null : null;
};

const isRelative = specifier => specifier === '.' || specifier === '..' ||
  specifier.startsWith('./') || specifier.startsWith('../');

function createLocalModuleResolver(files) {
  const modules = new Map();
  const callableParameterWritesCache = new WeakMap();
  const moduleByPath = new Map(files.map(fullPath => [path.resolve(fullPath), null]));

  const resolveRequest = (fromPath, specifier) => {
    if (!isRelative(specifier)) return null;
    const base = path.resolve(path.dirname(fromPath), specifier);
    const extension = path.extname(base);
    const stem = extension && ['.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx'].includes(extension)
      ? base.slice(0, -extension.length) : base;
    const candidates = [base, stem, `${stem}.js`, `${stem}.ts`, `${stem}.tsx`, `${stem}.cjs`, `${stem}.mjs`];
    const direct = candidates.find(candidate => moduleByPath.has(path.resolve(candidate)));
    if (direct) return path.resolve(direct);
    const packagePath = path.join(base, 'package.json');
    const fs = require('node:fs');
    if (fs.existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        if (typeof packageJson.main === 'string' && packageJson.main) {
          const packageBase = path.resolve(base, packageJson.main);
          const packageExtension = path.extname(packageBase);
          const packageStem = packageExtension && ['.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx']
            .includes(packageExtension) ? packageBase.slice(0, -packageExtension.length) : packageBase;
          const packageCandidates = [packageBase, packageStem, `${packageStem}.js`, `${packageStem}.ts`,
            `${packageStem}.tsx`, `${packageStem}.cjs`, `${packageStem}.mjs`,
            ...['.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx']
              .map(extension => path.join(packageStem, `index${extension}`))];
          const entry = packageCandidates.find(candidate => moduleByPath.has(path.resolve(candidate)));
          if (entry) return path.resolve(entry);
        }
      } catch {
        return null;
      }
    }
    const indexCandidates = [path.join(stem, 'index.js'), path.join(stem, 'index.ts')];
    return indexCandidates.find(candidate => moduleByPath.has(path.resolve(candidate))) || null;
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
    const initialExportObject = {};
    const module = {
      path: resolvedPath,
      bindings: new Map(),
      declaredBindings: new Set(),
      imports: new Map(),
      exports: new Map(),
      commonJsExports: new Map(),
      defaultExport: null,
      defaultExports: [],
      exportEquals: null,
      exportEqualsCandidates: [],
      wildcardExports: [],
      exportAliases: new Map([['exports', initialExportObject]]),
      nestedObjectProperties: new WeakMap(),
      initialExportObject,
      currentExportObject: initialExportObject,
      exportExpressionObjects: new WeakMap()
    };
    modules.set(resolvedPath, module);

    const addBinding = (name, expression) => {
      if (!name || !expression) return;
      const existing = module.bindings.get(name);
      if (existing) existing.push(expression);
      else module.bindings.set(name, [expression]);
    };
    const addExport = (name, value, exportObject = null) => {
      if (!name || !value) return;
      if (exportObject) {
        const commonJsValues = module.commonJsExports.get(String(name));
        const entry = { exportObject, value };
        if (commonJsValues) commonJsValues.push(entry);
        else module.commonJsExports.set(String(name), [entry]);
      }
      const existing = module.exports.get(name);
      if (existing) existing.push(value);
      else module.exports.set(name, [value]);
    };
    const exportValues = name => {
      const commonJsValues = module.commonJsExports.get(String(name));
      if (!commonJsValues) return module.exports.get(name) || [];
      return commonJsValues.filter(entry => entry.exportObject === module.currentExportObject)
        .map(entry => entry.value);
    };
    const addDefaultExport = expression => {
      if (!expression) return;
      module.defaultExport = expression;
      module.defaultExports.push(expression);
    };
    const addExportEquals = expression => {
      if (!expression) return;
      module.exportEquals = expression;
      module.exportEqualsCandidates.push(expression);
      addDefaultExport(expression);
    };
    const bindingContainsName = (name, expected) => {
      if (!name) return false;
      if (ts.isIdentifier(name)) return name.text === expected;
      if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        return name.elements.some(element => element.name && bindingContainsName(element.name, expected));
      }
      return false;
    };
    const statementDeclaresName = (statement, expected) => {
      if (ts.isVariableStatement(statement)) {
        const declarationList = statement.declarationList;
        return (declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0 &&
          declarationList.declarations.some(declaration => bindingContainsName(declaration.name, expected));
      }
      return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) && bindingContainsName(statement.name, expected);
    };
    const functionDeclaresVarName = (functionLike, expected) => {
      let found = false;
      const visit = node => {
        if (found || node !== functionLike && ts.isFunctionLike(node)) return;
        if (ts.isVariableDeclaration(node) && bindingContainsName(node.name, expected) &&
          (node.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
          found = true;
          return;
        }
        ts.forEachChild(node, visit);
      };
      if (functionLike.body) visit(functionLike.body);
      return found;
    };
    const hasLexicalCommonJsBinding = (identifier, expected) => {
      for (let scope = identifier.parent; scope; scope = scope.parent) {
        if (ts.isBlock(scope) && scope.statements.some(statement => statementDeclaresName(statement, expected))) return true;
        if (ts.isCaseBlock(scope) && scope.clauses.some(clause =>
          clause.statements.some(statement => statementDeclaresName(statement, expected)))) return true;
        if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
          ts.isVariableDeclarationList(scope.initializer) &&
          (scope.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0 &&
          scope.initializer.declarations.some(declaration => bindingContainsName(declaration.name, expected))) return true;
        if (ts.isCatchClause(scope) && scope.variableDeclaration &&
          bindingContainsName(scope.variableDeclaration.name, expected)) return true;
        if (ts.isFunctionLike(scope) && ((scope.parameters || []).some(parameter =>
          bindingContainsName(parameter.name, expected)) || scope.name && bindingContainsName(scope.name, expected) ||
          functionDeclaresVarName(scope, expected))) return true;
        if (ts.isSourceFile(scope) && scope.statements.some(statement => statementDeclaresName(statement, expected))) return true;
      }
      return false;
    };
    const hasLexicalCommonJsExportsBinding = identifier => hasLexicalCommonJsBinding(identifier, 'exports');
    const hasLexicalCommonJsModuleBinding = identifier => hasLexicalCommonJsBinding(identifier, 'module');
    const exportObjectIdentity = expression => {
      const node = unwrap(expression);
      if (!node) return null;
      if (ts.isIdentifier(node)) {
        if (node.text === 'exports' && hasLexicalCommonJsExportsBinding(node)) return null;
        return module.exportAliases.get(node.text) || null;
      }
      if (ts.isPropertyAccessExpression(node)) {
        if (node.name.text === 'exports' && ts.isIdentifier(node.expression) &&
          node.expression.text === 'module' && !hasLexicalCommonJsModuleBinding(node.expression)) {
          return module.currentExportObject;
        }
      }
      if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const name = unwrap(node.argumentExpression);
        if (node.expression.text === 'module' && !hasLexicalCommonJsModuleBinding(node.expression) &&
          (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) && name.text === 'exports') {
          return module.currentExportObject;
        }
      }
      if ((resolvedPath.endsWith('.cjs') || resolvedPath.endsWith('.js')) &&
        node.kind === ts.SyntaxKind.ThisKeyword) {
        let parent = node.parent;
        while (parent && !ts.isSourceFile(parent)) {
          if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent) ||
            ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) ||
            ts.isMethodDeclaration(parent) || ts.isGetAccessorDeclaration(parent) ||
            ts.isSetAccessorDeclaration(parent) || ts.isConstructorDeclaration(parent)) return null;
          parent = parent.parent;
        }
        return module.initialExportObject;
      }
      if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) ||
        ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
        ts.isClassExpression(node)) {
        let identity = module.exportExpressionObjects.get(node);
        if (!identity) {
          identity = {};
          module.exportExpressionObjects.set(node, identity);
        }
        return identity;
      }
      return null;
    };
    const isExportObjectExpression = expression => {
      const identity = exportObjectIdentity(expression);
      return Boolean(identity && identity === module.currentExportObject);
    };
    const recordExportAlias = (name, expression) => {
      if (!name) return;
      const identity = exportObjectIdentity(expression);
      if (identity) module.exportAliases.set(name, identity);
      else module.exportAliases.delete(name);
    };
    const recordVariable = (declaration, exported = false) => {
      if (ts.isIdentifier(declaration.name)) {
        module.declaredBindings.add(declaration.name.text);
        addBinding(declaration.name.text, declaration.initializer);
        if (declaration.name.text !== 'exports' ||
          !hasLexicalCommonJsExportsBinding(declaration.name)) {
          recordExportAlias(declaration.name.text, declaration.initializer);
        }
        if (exported) {
          // Exported bindings are live. Resolve through every recorded value,
          // including later assignments, instead of freezing the initializer.
          addExport(declaration.name.text, { binding: declaration.name.text });
        }
        return;
      }
      if (!declaration.initializer || (!ts.isObjectBindingPattern(declaration.name) &&
        !ts.isArrayBindingPattern(declaration.name))) return;
      let index = 0;
      for (const element of declaration.name.elements) {
        if (ts.isOmittedExpression(element)) {
          index += 1;
          continue;
        }
        if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
        const arrayBinding = ts.isArrayBindingPattern(declaration.name);
        const name = arrayBinding ? String(index++) : element.propertyName &&
          (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
          ? element.propertyName.text : element.name.text;
        module.declaredBindings.add(element.name.text);
        addBinding(element.name.text, { base: declaration.initializer, name });
        if (exported) addExport(element.name.text, { binding: element.name.text });
      }
    };
    const recordFunction = (declaration, exported = false) => {
      const isDefault = declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (!declaration.name) {
        if (exported && isDefault) {
          addDefaultExport(declaration);
        }
        return;
      }
      module.declaredBindings.add(declaration.name.text);
      addBinding(declaration.name.text, declaration);
      if (exported && !isDefault) addExport(declaration.name.text, { binding: declaration.name.text });
      if (isDefault) {
        addDefaultExport(declaration);
      }
    };
    const recordClass = (declaration, exported = false) => {
      const isDefault = declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword);
      if (!declaration.name) {
        if (exported && isDefault) addDefaultExport(declaration);
        return;
      }
      module.declaredBindings.add(declaration.name.text);
      addBinding(declaration.name.text, declaration);
      if (exported && !isDefault) addExport(declaration.name.text, { binding: declaration.name.text });
      if (isDefault) addDefaultExport(declaration);
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
    const staticTruthiness = (expression, visited = new Set()) => {
      const node = unwrap(expression);
      if (!node || visited.has(node)) return null;
      const seen = new Set(visited).add(node);
      if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
      if (node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return false;
      if (ts.isNumericLiteral(node)) return Number(node.text) !== 0;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.length > 0;
      if (ts.isVoidExpression(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) ||
        ts.isClassExpression(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) ||
        ts.isNewExpression(node) || ts.isClassDeclaration(node)) return !ts.isVoidExpression(node);
      if (ts.isIdentifier(node)) {
        if (node.text === 'undefined') return false;
        const bindings = module.bindings.get(node.text) || [];
        if (!bindings.length) return module.declaredBindings.has(node.text) ? false : null;
        const states = bindings.map(binding => staticTruthiness(binding, seen));
        return states.every(state => state === states[0]) ? states[0] : null;
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'kill' &&
        ts.isIdentifier(node.expression) && node.expression.text === 'process' &&
        !module.declaredBindings.has('process')) return true;
      return null;
    };
    const staticNullishness = (expression, visited = new Set()) => {
      const node = unwrap(expression);
      if (!node || visited.has(node)) return null;
      const seen = new Set(visited).add(node);
      if (node.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(node) ||
        ts.isIdentifier(node) && node.text === 'undefined') return true;
      if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword ||
        ts.isNumericLiteral(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassExpression(node) ||
        ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isNewExpression(node)) return false;
      if (ts.isIdentifier(node)) {
        const bindings = module.bindings.get(node.text) || [];
        if (!bindings.length) return module.declaredBindings.has(node.text) ? true : null;
        const states = bindings.map(binding => staticNullishness(binding, seen));
        return states.every(state => state === states[0]) ? states[0] : null;
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'kill' &&
        ts.isIdentifier(node.expression) && node.expression.text === 'process' &&
        !module.declaredBindings.has('process')) return false;
      return null;
    };
    const exportPropertyState = (left, classify) => {
      if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return null;
      if (!isExportObjectExpression(left.expression)) return null;
      const name = propertyName(left, identifier => staticPropertyValue(identifier, resolvedPath));
      if (!name) return null;
      const states = exportValues(String(name)).map(value => classify(value));
      return states.length && states.every(state => state === states[0]) ? states[0] : null;
    };
    const assignmentValue = value => {
      let current = unwrap(value);
      while (ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.EqualsToken) current = unwrap(current.right);
      return current;
    };
    const recordAssignment = (expression, includedNames = null) => {
      if (!ts.isBinaryExpression(expression)) return;
      const operator = expression.operatorToken.kind;
      const logicalOperator = [ts.SyntaxKind.QuestionQuestionEqualsToken,
        ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(operator);
      if (operator !== ts.SyntaxKind.EqualsToken && !logicalOperator) return;
      const left = unwrap(expression.left);
      const nullishness = staticNullishness(left) ?? exportPropertyState(left, staticNullishness);
      const truthiness = staticTruthiness(left) ?? exportPropertyState(left, staticTruthiness);
      if (operator === ts.SyntaxKind.QuestionQuestionEqualsToken && nullishness === false ||
        operator === ts.SyntaxKind.BarBarEqualsToken && truthiness === true ||
        operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken && truthiness === false) return;
      if (ts.isIdentifier(left)) {
        if (includedNames && !includedNames.has(left.text)) return;
        addBinding(left.text, expression.right);
        if (left.text !== 'exports' || !hasLexicalCommonJsExportsBinding(left)) {
          recordExportAlias(left.text, expression.right);
        }
      } else if (ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left)) {
        const recordPattern = (pattern, source, property = null) => {
          const target = unwrap(pattern);
          if (ts.isIdentifier(target)) {
            if (includedNames && !includedNames.has(target.text)) return;
            addBinding(target.text, property === null ? source : { base: source, name: property });
            return;
          }
          if (ts.isArrayLiteralExpression(target) && ts.isArrayLiteralExpression(source)) {
            for (let index = 0; index < target.elements.length; index += 1) {
              const element = target.elements[index];
              const value = source.elements[index];
              if (!element || !value || ts.isSpreadElement(element) || ts.isSpreadElement(value)) continue;
              recordPattern(element, source, String(index));
            }
            return;
          }
          if (!ts.isObjectLiteralExpression(target)) return;
          for (const element of target.properties) {
            if (ts.isShorthandPropertyAssignment(element)) {
              recordPattern(element.name, source, element.name.text);
            } else if (ts.isPropertyAssignment(element) && element.name) {
              const name = ts.isIdentifier(element.name) || ts.isStringLiteral(element.name)
                ? element.name.text : null;
              if (name !== null) recordPattern(element.initializer, source, name);
            }
          }
        };
        recordPattern(left, expression.right);
      }
      const name = propertyName(left, identifier => staticPropertyValue(identifier, resolvedPath));
      if (!name || !ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return;
      const receiver = left.expression;
      if (isExportObjectExpression(receiver)) {
        addExport(name, assignmentValue(expression.right), exportObjectIdentity(receiver));
      }
      const nestedPath = exportObjectPath(receiver);
      const nestedObjects = new Set(nestedPath ? exportedObjectLiterals(nestedPath) : []);
      if (ts.isIdentifier(receiver) && module.imports.has(receiver.text)) {
        for (const atom of evaluate(receiver, resolvedPath, new Set())) {
          if (atom?.objectLiteral) nestedObjects.add(atom.objectLiteral);
        }
      }
      for (const object of nestedObjects) {
        const objectOwner = scanModule(object.getSourceFile().fileName) || module;
        let properties = objectOwner.nestedObjectProperties.get(object);
        if (!properties) {
          properties = new Map();
          objectOwner.nestedObjectProperties.set(object, properties);
        }
        const existing = properties.get(String(name));
        if (existing) existing.push(assignmentValue(expression.right));
        else properties.set(String(name), [assignmentValue(expression.right)]);
      }
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'exports' &&
        ts.isIdentifier(left.expression) && left.expression.text === 'module' &&
        !hasLexicalCommonJsModuleBinding(left.expression)) {
        addExportEquals(assignmentValue(expression.right));
      }
      if (ts.isElementAccessExpression(left) && name === 'exports' && ts.isIdentifier(left.expression) &&
        left.expression.text === 'module' && !hasLexicalCommonJsModuleBinding(left.expression)) {
        addExportEquals(assignmentValue(expression.right));
      }
      const replacesModuleExports = ts.isPropertyAccessExpression(left) && left.name.text === 'exports' &&
        ts.isIdentifier(left.expression) && left.expression.text === 'module' &&
        !hasLexicalCommonJsModuleBinding(left.expression) ||
        ts.isElementAccessExpression(left) && name === 'exports' && ts.isIdentifier(left.expression) &&
        left.expression.text === 'module' && !hasLexicalCommonJsModuleBinding(left.expression);
      if (replacesModuleExports) {
        module.currentExportObject = exportObjectIdentity(assignmentValue(expression.right)) || {};
      }
    };
    const exportObjectPath = expression => {
      const names = [];
      let node = unwrap(expression);
      while (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const property = propertyName(node, identifier => staticPropertyValue(identifier, resolvedPath));
        if (property === null) return null;
        names.unshift(String(property));
        node = unwrap(node.expression);
      }
      return names.length && isExportObjectExpression(node) ? names : null;
    };
    const objectLiteralsFor = (source, visited = new Set()) => {
      if (!source) return [];
      const value = unwrap(source);
      if (ts.isObjectLiteralExpression(value)) return [value];
      if (!ts.isIdentifier(value) || visited.has(value.text)) return [];
      const next = new Set(visited).add(value.text);
      return (module.bindings.get(value.text) || []).flatMap(binding => objectLiteralsFor(binding, next));
    };
    const propertyValuesFor = (object, propertyName, visited = new Set()) => {
      if (visited.has(object)) return [];
      const seen = new Set(visited).add(object);
      const values = [];
      for (const property of object.properties) {
        if (ts.isSpreadAssignment(property)) {
          for (const source of objectLiteralsFor(property.expression)) {
            values.push(...propertyValuesFor(source, propertyName, seen));
          }
          continue;
        }
        if (!property.name) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ||
          ts.isNumericLiteral(property.name) ? property.name.text
          : ts.isComputedPropertyName(property.name)
            ? staticPropertyValue(property.name.expression, resolvedPath) : null;
        if (key !== propertyName) continue;
        if (ts.isPropertyAssignment(property)) values.push(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property)) values.push(property.name);
      }
      return values;
    };
    const exportedObjectLiterals = names => {
      let values = exportValues(names[0]);
      for (const propertyName of names.slice(1)) {
        values = values.flatMap(value => objectLiteralsFor(value)
          .flatMap(object => propertyValuesFor(object, propertyName)));
      }
      return values.flatMap(value => objectLiteralsFor(value));
    };
    const recordExportExpression = expression => {
      if (expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isBinaryExpression(expression.right)) {
        recordExportExpression(expression.right);
      }
      const left = unwrap(expression.left);
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'exports' &&
        ts.isIdentifier(left.expression) && left.expression.text === 'module' &&
        !hasLexicalCommonJsModuleBinding(left.expression)) {
        addExportEquals(assignmentValue(expression.right));
        if (ts.isObjectLiteralExpression(expression.right)) {
          for (const property of expression.right.properties) {
            if (!property.name || (!ts.isPropertyAssignment(property) &&
              !ts.isShorthandPropertyAssignment(property))) continue;
            const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
              ? property.name.text : null;
            const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
            addExport(name, value, exportObjectIdentity(assignmentValue(expression.right)));
          }
        }
      }
      recordAssignment(expression);
    };
    const recordExportAssignment = statement => {
      if (statement.isExportEquals) {
        addExportEquals(statement.expression);
      }
    };
    const recordDefineProperty = expression => {
      if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression) ||
        expression.expression.name.text !== 'defineProperty' ||
        !ts.isIdentifier(expression.expression.expression) || expression.expression.expression.text !== 'Object' ||
        !isUnshadowedGlobalName(expression.expression.expression, 'Object', module)) return;
      const [target, key, descriptor] = expression.arguments;
      if (!target || !key || !descriptor || !isExportObjectExpression(target) ||
        !ts.isObjectLiteralExpression(descriptor)) return;
      const exportName = staticPropertyValue(key, resolvedPath);
      if (exportName === null) return;
      for (const property of descriptor.properties) {
        if (!property.name) continue;
        const propertyName = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text : null;
        if (propertyName === 'value' && ts.isPropertyAssignment(property)) {
          addExport(String(exportName), property.initializer, exportObjectIdentity(target));
        } else if (propertyName === 'get') {
          const getter = ts.isPropertyAssignment(property) ? property.initializer : property;
          for (const expression of callableReturnExpressions(getter)) {
            addExport(String(exportName), expression, exportObjectIdentity(target));
          }
        }
      }
    };
    const recordObjectAssign = expression => {
      if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression) ||
        expression.expression.name.text !== 'assign' ||
        !ts.isIdentifier(expression.expression.expression) || expression.expression.expression.text !== 'Object' ||
        module.declaredBindings.has('Object')) return;
      const target = expression.arguments[0];
      if (!target || !isExportObjectExpression(target)) return;
      const objectLiteralsFor = (source, visited = new Set()) => {
        const value = unwrap(source);
        if (ts.isObjectLiteralExpression(value)) return [value];
        if (!ts.isIdentifier(value) || visited.has(value.text)) return [];
        const next = new Set(visited).add(value.text);
        return (module.bindings.get(value.text) || []).flatMap(binding => objectLiteralsFor(binding, next));
      };
      for (const source of expression.arguments.slice(1)) {
        for (const object of objectLiteralsFor(source)) {
          for (const property of object.properties) {
            if (!property.name || (!ts.isPropertyAssignment(property) &&
              !ts.isShorthandPropertyAssignment(property))) continue;
            const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ||
              ts.isNumericLiteral(property.name) ? property.name.text : null;
            if (name === null) continue;
            addExport(name, ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer,
              exportObjectIdentity(target));
          }
        }
      }
    };
    const scannedCallables = new Set();
    const callableBindingName = callable => {
      if (callable.name && ts.isIdentifier(callable.name)) return callable.name.text;
      const parent = callable.parent;
      if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent)) && ts.isIdentifier(parent.name)) return parent.name.text;
      return null;
    };
    const callableIsReferencedWithin = (candidate, scope) => {
      const name = callableBindingName(candidate);
      if (!name) return true;
      let referenced = false;
      const visitReference = node => {
        if (referenced || node === candidate || node !== scope && ts.isFunctionLike(node)) return;
        if (ts.isIdentifier(node) && node.text === name) {
          const parent = node.parent;
          const isDeclaration = parent && parent.name === node && (
            ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) ||
            ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
          );
          const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
          if (!isDeclaration && !isPropertyName) {
            referenced = true;
            return;
          }
        }
        ts.forEachChild(node, visitReference);
      };
      visitReference(scope.body || scope);
      return referenced;
    };
    const scanCallableModuleWrites = callable => {
      if (scannedCallables.has(callable)) return;
      scannedCallables.add(callable);
      const hasBindingName = (binding, name) => {
        if (ts.isIdentifier(binding)) return binding.text === name;
        if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
          return binding.elements.some(element => ts.isBindingElement(element) &&
            hasBindingName(element.name, name));
        }
        return false;
      };
      const blockDeclares = (block, name) => block.statements.some(statement => {
        if (ts.isVariableStatement(statement) &&
          (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) {
          return statement.declarationList.declarations.some(declaration => hasBindingName(declaration.name, name));
        }
        return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === name;
      });
      const hasVarDeclaration = (functionLike, name) => {
        let found = false;
        const visit = child => {
          if (found || child !== functionLike.body && ts.isFunctionLike(child)) return;
          if (ts.isVariableDeclaration(child) && hasBindingName(child.name, name) &&
            (child.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
            found = true;
            return;
          }
          ts.forEachChild(child, visit);
        };
        if (functionLike.body) visit(functionLike.body);
        return found;
      };
      const hasLocalBinding = (functionLike, assignment, name) => {
        let current = assignment.parent;
        while (current && !ts.isSourceFile(current)) {
          if (ts.isBlock(current) && blockDeclares(current, name)) return true;
          if ((ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) &&
            ts.isVariableDeclarationList(current.initializer) &&
            current.initializer.declarations.some(declaration => hasBindingName(declaration.name, name))) return true;
          if (ts.isCatchClause(current) && current.variableDeclaration &&
            hasBindingName(current.variableDeclaration.name, name)) return true;
          if (ts.isFunctionLike(current)) {
            if (ts.isFunctionExpression(current) && current.name?.text === name || current.parameters?.some(parameter =>
              hasBindingName(parameter.name, name)) || hasVarDeclaration(current, name)) return true;
          }
          if ((ts.isClassDeclaration(current) || ts.isClassExpression(current)) && current.name?.text === name) return true;
          current = current.parent;
        }
        return false;
      };
      const assignmentNames = pattern => {
        const target = unwrap(pattern);
        if (ts.isIdentifier(target)) return [target.text];
        if (ts.isArrayLiteralExpression(target)) return target.elements.flatMap(element =>
          ts.isOmittedExpression(element) || ts.isSpreadElement(element) ? [] : assignmentNames(element));
        if (ts.isObjectLiteralExpression(target)) return target.properties.flatMap(property => {
          if (ts.isShorthandPropertyAssignment(property)) return [property.name.text];
          if (ts.isPropertyAssignment(property)) return assignmentNames(property.initializer);
          return [];
        });
        return [];
      };
      const visit = child => {
        if (child !== callable && ts.isFunctionLike(child)) {
          const isClassMember = ts.isClassDeclaration(callable) || ts.isClassExpression(callable);
          if (isClassMember || callableIsReferencedWithin(child, callable)) scanCallableModuleWrites(child);
          return;
        }
        if (ts.isBinaryExpression(child)) {
          const names = assignmentNames(child.left).filter(name =>
            module.declaredBindings.has(name) && !hasLocalBinding(callable, child, name));
          if (names.length) recordAssignment(child, new Set(names));
        }
        ts.forEachChild(child, visit);
      };
      if (callable.body) visit(callable.body);
      else if (ts.isClassDeclaration(callable) || ts.isClassExpression(callable)) visit(callable);
    };
    const scanModuleLevel = node => {
      if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return;
      if (ts.isIfStatement(node)) {
        const condition = unwrap(node.expression);
        if (condition.kind === ts.SyntaxKind.TrueKeyword) {
          scanModuleLevel(node.thenStatement);
        } else if (condition.kind === ts.SyntaxKind.FalseKeyword) {
          if (node.elseStatement) scanModuleLevel(node.elseStatement);
        } else {
          scanModuleLevel(node.thenStatement);
          if (node.elseStatement) scanModuleLevel(node.elseStatement);
        }
        return;
      }
      if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) ||
        ts.isClassExpression(node)) {
        scanCallableModuleWrites(node);
        return;
      }
      if (ts.isBinaryExpression(node)) recordAssignment(node);
      if (ts.isCallExpression(node)) {
        recordDefineProperty(node);
        recordObjectAssign(node);
      }
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
        const specifier = moduleSpecifier && ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : null;
        const builtinProcess = specifier === 'node:process' || specifier === 'process';
        const modulePath = moduleSpecifier && ts.isStringLiteral(moduleSpecifier)
          ? resolveRequest(resolvedPath, specifier) : null;
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const specifier of statement.exportClause.elements) {
            const exported = specifier.name.text;
            const imported = (specifier.propertyName || specifier.name).text;
            if (modulePath) addExport(exported, { modulePath, name: imported });
            else if (builtinProcess) addExport(exported, { builtin: 'process', name: imported });
            else addExport(exported, { binding: imported });
          }
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause) &&
          (modulePath || builtinProcess)) {
          const exported = statement.exportClause.name.text;
          addBinding(exported, modulePath
            ? { namespaceModulePath: modulePath } : { builtinNamespace: 'process' });
          addExport(exported, { binding: exported });
        } else if (modulePath || builtinProcess) {
          module.wildcardExports.push(modulePath || { builtin: 'process' });
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
    const callableDeclarations = new Map();
    const reachableCallables = new Set();
    const pendingCallables = [];
    const addReachableCallable = callable => {
      if (!callable || reachableCallables.has(callable)) return;
      reachableCallables.add(callable);
      pendingCallables.push(callable);
    };
    for (const statement of sourceFile.statements) {
      if (!ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement)) continue;
      if (statement.name) {
        const existing = callableDeclarations.get(statement.name.text) || [];
        existing.push(statement);
        callableDeclarations.set(statement.name.text, existing);
      }
      const isExported = statement.modifiers?.some(modifier =>
        modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) || false;
      if (isExported) addReachableCallable(statement);
    }
    const includeCallableReferences = root => {
      const visit = node => {
        if (node !== root && (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
          const isClassMember = (ts.isClassDeclaration(root) || ts.isClassExpression(root)) &&
            (node.parent === root || node.parent.parent === root && ts.isPropertyDeclaration(node.parent));
          if (!isClassMember) return;
        }
        if (ts.isIdentifier(node)) {
          const parent = node.parent;
          const isDeclaration = parent && parent.name === node && (
            ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) ||
            ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
          );
          const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
          if (!isDeclaration && !isPropertyName) {
            for (const callable of callableDeclarations.get(node.text) || []) addReachableCallable(callable);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(root);
    };
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) continue;
      includeCallableReferences(statement);
    }
    while (pendingCallables.length) includeCallableReferences(pendingCallables.shift());
    for (const callable of reachableCallables) scanCallableModuleWrites(callable);
    scanModuleLevel(sourceFile);
    return module;
  };

  const bindingPatternContains = (pattern, name) => {
    if (ts.isIdentifier(pattern)) return pattern.text === name;
    if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
      return pattern.elements.some(element => bindingPatternContains(element.name, name));
    }
    return false;
  };

  const isUnshadowedGlobalName = (identifier, name, module) => {
    if (!ts.isIdentifier(identifier) || identifier.text !== name || module?.declaredBindings.has(name)) return false;
    for (let scope = identifier.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
      if ((ts.isFunctionDeclaration(scope) || ts.isFunctionExpression(scope) || ts.isArrowFunction(scope) ||
        ts.isMethodDeclaration(scope)) &&
        scope.parameters.some(parameter => bindingPatternContains(parameter.name, name))) return false;
      if ((ts.isClassDeclaration(scope) || ts.isClassExpression(scope)) && scope.name?.text === name) return false;
      if (ts.isCatchClause(scope) && scope.variableDeclaration &&
        bindingPatternContains(scope.variableDeclaration.name, name)) return false;
      if (ts.isBlock(scope) && scope.statements.some(statement => {
        if (ts.isVariableStatement(statement)) {
          return statement.declarationList.declarations.some(declaration =>
            bindingPatternContains(declaration.name, name));
        }
        return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === name;
      })) return false;
      if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
        scope.initializer && ts.isVariableDeclarationList(scope.initializer) &&
        scope.initializer.declarations.some(declaration => bindingPatternContains(declaration.name, name))) {
        return false;
      }
    }
    return true;
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
        const getter = ts.isGetAccessorDeclaration(property);
        const method = ts.isMethodDeclaration(property);
        if (!property.name || (!ts.isPropertyAssignment(property) &&
          !ts.isShorthandPropertyAssignment(property) && !getter && !method)) continue;
        const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : ts.isComputedPropertyName(property.name)
            ? staticPropertyValue(property.name.expression, currentPath, seen)
            : null;
        if (key !== name) continue;
        if (method) {
          result.add({ callable: property, modulePath: currentPath });
          continue;
        }
        if (getter) {
          const statements = property.body?.statements || [];
          if (statements.length === 1 && ts.isReturnStatement(statements[0]) && statements[0].expression) {
            for (const atom of evaluate(statements[0].expression, currentPath, seen, new Map(), bindingOverrides)) {
              result.add(atom);
            }
          }
          continue;
        }
        const value = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
        for (const atom of evaluate(value, currentPath, seen, new Map(), bindingOverrides)) result.add(atom);
      }
      const ownerModule = currentPath && modules.get(path.resolve(currentPath));
      const nestedWrites = ownerModule?.nestedObjectProperties.get(node)?.get(String(name)) || [];
      for (const value of nestedWrites) {
        for (const atom of evaluate(value, currentPath, seen, new Map(), bindingOverrides)) result.add(atom);
      }
      return result;
    }
    if (ts.isArrayLiteralExpression(node)) {
      const index = Number(name);
      if (!Number.isInteger(index) || index < 0) return new Set();
      const element = node.elements[index];
      if (!element || ts.isSpreadElement(element)) return new Set();
      return evaluate(element, currentPath, seen, new Map(), bindingOverrides);
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
      if (atom && atom.objectLiteral) {
        for (const nested of evaluateProperty(
          atom.objectLiteral,
          name,
          atom.modulePath || currentPath,
          seen,
          bindingOverrides
        )) result.add(nested);
        continue;
      }
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

  const constructorPropertyExpressions = (declaration, name) => {
    const constructor = declaration.members.find(member => ts.isConstructorDeclaration(member));
    if (!constructor?.body) return [];
    const expressions = [];
    const visit = node => {
      if (node !== constructor.body && ts.isFunctionLike(node)) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrap(node.left);
        if (ts.isPropertyAccessExpression(left) && left.name.text === String(name) &&
          left.expression.kind === ts.SyntaxKind.ThisKeyword) expressions.push(node.right);
      }
      ts.forEachChild(node, visit);
    };
    visit(constructor.body);
    return expressions;
  };

  const resolveClassProperty = (atom, name, currentPath, visited) => {
    if (!atom?.classDeclaration) return new Set();
    if (visited.has(atom.classDeclaration)) return new Set();
    const result = new Set();
    const declaration = atom.classDeclaration;
    const seen = new Set(visited).add(declaration);
    const expressions = classPropertyExpressions(declaration, name, !atom.instance);
    if (atom.instance) expressions.push(...constructorPropertyExpressions(declaration, name));
    let hasParameterProperty = false;
    for (const expression of expressions) {
      if (ts.isGetAccessorDeclaration(expression)) {
        for (const returnExpression of callableReturnExpressions(expression)) {
          for (const nested of evaluate(returnExpression, atom.modulePath || currentPath, seen)) result.add(nested);
        }
      } else if (ts.isMethodDeclaration(expression)) {
        result.add({ callable: expression, modulePath: atom.modulePath || currentPath });
      } else {
        for (const nested of evaluate(expression, atom.modulePath || currentPath, seen)) result.add(nested);
      }
    }
    if (atom.instance) {
      const constructor = declaration.members.find(member => ts.isConstructorDeclaration(member));
      for (const parameter of constructor?.parameters || []) {
        if (!ts.isIdentifier(parameter.name) || parameter.name.text !== String(name)) continue;
        const isParameterProperty = parameter.modifiers?.some(modifier => [
          ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ProtectedKeyword, ts.SyntaxKind.PrivateKeyword,
          ts.SyntaxKind.ReadonlyKeyword
        ].includes(modifier.kind)) || false;
        if (!isParameterProperty) continue;
        hasParameterProperty = true;
        const binding = atom.constructorBindings?.get(parameter.name.text);
        const value = binding?.expression || parameter.initializer;
        const valuePath = binding?.expression ? binding.currentPath : atom.modulePath || currentPath;
        if (value) {
          for (const nested of evaluate(value, valuePath, seen)) result.add(nested);
        }
        if (binding?.fallback) {
          for (const nested of evaluate(binding.fallback, binding.fallbackPath || atom.modulePath || currentPath, seen)) {
            result.add(nested);
          }
        }
      }
    }
    if (expressions.length || hasParameterProperty) return result;
    for (const heritage of declaration.heritageClauses || []) {
      if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const type of heritage.types) {
        for (const parent of evaluate(type.expression, atom.modulePath || currentPath, seen)) {
          if (!parent?.classDeclaration) continue;
          for (const nested of resolveClassProperty({ ...parent, instance: atom.instance }, name,
            atom.modulePath || currentPath, seen)) result.add(nested);
        }
      }
    }
    return result;
  };

  const resolveProperty = (atoms, name, currentPath, visited = new Set()) => {
    const objectAtoms = [...atoms].filter(atom => atom && atom.objectLiteral);
    if (objectAtoms.length) {
      const result = new Set();
      for (const atom of objectAtoms) {
        for (const nested of evaluateProperty(
          atom.objectLiteral,
          name,
          atom.modulePath || currentPath,
          visited
        )) result.add(nested);
      }
      const remaining = new Set([...atoms].filter(atom => !atom || !atom.objectLiteral));
      if (remaining.size) {
        for (const nested of resolveProperty(remaining, name, currentPath, visited)) result.add(nested);
      }
      return result;
    }
    const result = new Set();
    for (const atom of atoms || []) {
      const modulePath = modulePathFromAtom(atom);
      if (modulePath) {
        for (const nested of resolveExport(modulePath, String(name), visited)) result.add(nested);
      } else {
        for (const nested of resolveClassProperty(atom, name, currentPath, visited)) result.add(nested);
      }
      const attachedDeclaration = atom?.callable || atom?.classDeclaration;
      if (attachedDeclaration && (ts.isFunctionDeclaration(attachedDeclaration) ||
        ts.isClassDeclaration(attachedDeclaration)) && attachedDeclaration.name) {
        const callablePath = atom.modulePath || modulePath || currentPath;
        for (const statement of attachedDeclaration.getSourceFile().statements) {
          if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression) ||
            statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
          const left = unwrap(statement.expression.left);
          if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) continue;
          if (!ts.isIdentifier(left.expression) || left.expression.text !== attachedDeclaration.name.text) continue;
          const assignedName = ts.isPropertyAccessExpression(left) ? left.name.text
            : staticPropertyValue(left.argumentExpression, callablePath);
          if (String(assignedName) !== String(name)) continue;
          for (const nested of evaluate(statement.expression.right, callablePath, visited)) result.add(nested);
        }
      }
    }
    return result;
  };

  const resolveNew = (atoms, argumentsList = [], callerPath = null) => {
    const result = new Set();
    for (const atom of atoms || []) {
      if (atom?.classDeclaration) {
        const classPath = atom.modulePath || callerPath;
        const constructor = atom.classDeclaration.members.find(member => ts.isConstructorDeclaration(member));
        result.add({
          classDeclaration: atom.classDeclaration,
          modulePath: atom.modulePath,
          instance: true,
          constructorBindings: constructor
            ? callableParameterBindings(constructor, argumentsList || [], callerPath, classPath)
            : new Map()
        });
      }
    }
    return result;
  };

  const undefinedState = (expression, currentPath, visited = new Set()) => {
    const node = unwrap(expression);
    if (!node || visited.has(node)) return null;
    const seen = new Set(visited).add(node);
    if (ts.isVoidExpression(node)) return true;
    if (ts.isIdentifier(node)) {
      const module = currentPath && scanModule(currentPath);
      if (node.text === 'undefined' && !module?.declaredBindings.has(node.text)) return true;
      const bindings = module?.bindings.get(node.text) || [];
      if (!bindings.length) return module?.declaredBindings.has(node.text) ? true : null;
      const states = bindings.map(binding => undefinedState(binding, currentPath, seen));
      if (states.every(state => state === true)) return true;
      if (states.every(state => state === false)) return false;
      return null;
    }
    if (ts.isConditionalExpression(node)) {
      const branches = [undefinedState(node.whenTrue, currentPath, seen),
        undefinedState(node.whenFalse, currentPath, seen)];
      if (branches.every(state => state === true)) return true;
      if (branches.every(state => state === false)) return false;
      return null;
    }
    if (node.kind === ts.SyntaxKind.NullKeyword || ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isObjectLiteralExpression(node) ||
      ts.isArrayLiteralExpression(node) || ts.isClassExpression(node) || ts.isNewExpression(node)) return false;
    return null;
  };
  const mayBeUndefined = (expression, currentPath, property = null, visited = new Set()) => {
    const node = unwrap(expression);
    if (!node || visited.has(node)) return true;
    const seen = new Set(visited).add(node);
    if (property !== null) {
      if (ts.isObjectLiteralExpression(node)) {
        for (const element of node.properties) {
          if (ts.isSpreadAssignment(element)) return true;
          if (!element.name || (!ts.isPropertyAssignment(element) &&
            !ts.isShorthandPropertyAssignment(element))) continue;
          const name = ts.isIdentifier(element.name) || ts.isStringLiteral(element.name)
            ? element.name.text : null;
          if (name !== property) continue;
          const value = ts.isShorthandPropertyAssignment(element) ? element.name : element.initializer;
          return undefinedState(value, currentPath) !== false;
        }
        return true;
      }
      if (ts.isArrayLiteralExpression(node)) {
        const index = Number(property);
        const element = Number.isInteger(index) && index >= 0 ? node.elements[index] : undefined;
        return !element || ts.isSpreadElement(element) || undefinedState(element, currentPath) !== false;
      }
      if (ts.isIdentifier(node)) {
        const module = currentPath && scanModule(currentPath);
        const bindings = module?.bindings.get(node.text) || [];
        return !bindings.length || bindings.some(binding => mayBeUndefined(binding, currentPath, property, seen));
      }
      return true;
    }
    return undefinedState(node, currentPath) !== false;
  };

  const callableParameterBindings = (callable, argumentsList, callerPath, callablePath = callerPath) => {
    const bindings = new Map();
    for (let index = 0; index < (callable.parameters || []).length; index += 1) {
      const parameter = callable.parameters[index];
      const suppliedArgument = argumentsList === null ? undefined : argumentsList?.[index];
      const explicitUndefined = suppliedArgument !== undefined &&
        undefinedState(suppliedArgument, callerPath) === true;
      const argument = suppliedArgument === undefined || explicitUndefined
        ? parameter.initializer : suppliedArgument;
      const argumentPath = suppliedArgument === undefined || explicitUndefined ? callablePath : callerPath;
      const fallback = suppliedArgument !== undefined && !explicitUndefined && parameter.initializer &&
        mayBeUndefined(suppliedArgument, callerPath) ? parameter.initializer : null;
      if (!argument && !ts.isObjectBindingPattern(parameter.name) && !ts.isArrayBindingPattern(parameter.name)) continue;
      if (ts.isIdentifier(parameter.name)) {
        bindings.set(parameter.name.text, { expression: argument, currentPath: argumentPath,
          fallback, fallbackPath: callablePath });
        continue;
      }
      if (ts.isObjectBindingPattern(parameter.name)) {
        for (const element of parameter.name.elements) {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          const property = element.propertyName && (ts.isIdentifier(element.propertyName) ||
            ts.isStringLiteral(element.propertyName)) ? element.propertyName.text : element.name.text;
          const usesParameterDefault = fallback && mayBeUndefined(argument, argumentPath, property);
          const usesElementDefault = element.initializer && mayBeUndefined(argument, argumentPath, property);
          bindings.set(element.name.text, { expression: argument, name: property, currentPath: argumentPath,
            parameterFallback: usesParameterDefault ? fallback : null,
            parameterFallbackPath: callablePath,
            fallback: usesElementDefault ? element.initializer : null, fallbackPath: callablePath });
        }
      }
      if (ts.isArrayBindingPattern(parameter.name)) {
        for (let elementIndex = 0; elementIndex < parameter.name.elements.length; elementIndex += 1) {
          const element = parameter.name.elements[elementIndex];
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
          const property = String(elementIndex);
          const usesParameterDefault = fallback && mayBeUndefined(argument, argumentPath, property);
          const usesElementDefault = element.initializer && mayBeUndefined(argument, argumentPath, property);
          bindings.set(element.name.text, { expression: argument, name: property, currentPath: argumentPath,
            parameterFallback: usesParameterDefault ? fallback : null,
            parameterFallbackPath: callablePath,
            fallback: usesElementDefault ? element.initializer : null, fallbackPath: callablePath });
        }
      }
    }
    return bindings;
  };

  const callableParameterWrites = callable => {
    const cached = callableParameterWritesCache.get(callable);
    if (cached) return cached;
    const writes = [];
    const parameters = callable.parameters || [];
    const bindingContainsName = (binding, name) => {
      if (ts.isIdentifier(binding)) return binding.text === name;
      if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
        return binding.elements.some(element => element.name && bindingContainsName(element.name, name));
      }
      return false;
    };
    const statementDeclaresName = (statement, name) => {
      if (ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) {
        return statement.declarationList.declarations.some(declaration =>
          bindingContainsName(declaration.name, name));
      }
      return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name?.text === name;
    };
    const parameterIsShadowedAt = (node, name) => {
      for (let scope = node.parent; scope && scope !== callable.body; scope = scope.parent) {
        if (ts.isBlock(scope) && scope.statements.some(statement => statementDeclaresName(statement, name))) return true;
        if (ts.isCaseBlock(scope) && scope.clauses.some(clause =>
          clause.statements.some(statement => statementDeclaresName(statement, name)))) return true;
        if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
          ts.isVariableDeclarationList(scope.initializer) &&
          (scope.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0 &&
          scope.initializer.declarations.some(declaration => bindingContainsName(declaration.name, name))) return true;
        if (ts.isCatchClause(scope) && scope.variableDeclaration &&
          bindingContainsName(scope.variableDeclaration.name, name)) return true;
      }
      return false;
    };
    const visit = node => {
      if (node !== callable && ts.isFunctionLike(node)) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrap(node.left);
        if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
          const receiver = unwrap(left.expression);
          if (ts.isIdentifier(receiver)) {
            const parameterIndex = parameters.findIndex(parameter => ts.isIdentifier(parameter.name) &&
              parameter.name.text === receiver.text);
            const name = ts.isPropertyAccessExpression(left) ? left.name.text
              : staticPropertyValue(left.argumentExpression, callable.getSourceFile().fileName);
            if (parameterIndex >= 0 && name !== null && !parameterIsShadowedAt(receiver, receiver.text)) {
              writes.push({ parameterIndex, name: String(name), expression: node.right });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    if (callable.body) visit(callable.body);
    callableParameterWritesCache.set(callable, writes);
    return writes;
  };

  const localBindingSources = (node, name) => {
    const hasBindingName = binding => {
      if (ts.isIdentifier(binding)) return binding.text === name;
      if (ts.isObjectBindingPattern(binding) || ts.isArrayBindingPattern(binding)) {
        return binding.elements.some(element => ts.isBindingElement(element) && hasBindingName(element.name));
      }
      return false;
    };
    const blockDeclares = block => block.statements.some(statement => {
      if (ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) {
        return statement.declarationList.declarations.some(declaration => hasBindingName(declaration.name));
      }
      return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name?.text === name;
    });
    const loopDeclares = statement =>
      (ts.isForStatement(statement) || ts.isForInStatement(statement) || ts.isForOfStatement(statement)) &&
      statement.initializer && ts.isVariableDeclarationList(statement.initializer) &&
      statement.initializer.declarations.some(declaration => hasBindingName(declaration.name));
    const callableShadows = callable => {
      if (ts.isFunctionExpression(callable) && callable.name?.text === name ||
        callable.parameters?.some(parameter => hasBindingName(parameter.name))) return true;
      let found = false;
      const inspect = child => {
        if (found || child !== callable.body && ts.isFunctionLike(child)) return;
        if (ts.isVariableDeclaration(child) && hasBindingName(child.name) &&
          (child.parent.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
          found = true;
          return;
        }
        ts.forEachChild(child, inspect);
      };
      if (callable.body) inspect(callable.body);
      return found;
    };
    const callableName = callable => {
      if (ts.isFunctionDeclaration(callable)) return callable.name?.text || null;
      if (ts.isFunctionExpression(callable) && callable.name) return callable.name.text;
      const declaration = callable.parent;
      return ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
        ? declaration.name.text : null;
    };
    const calledBeforeUse = callable => {
      if (ts.isCallExpression(callable.parent) && callable.parent.expression === callable &&
        callable.parent.end <= node.pos) return true;
      const name = callableName(callable);
      if (!name || !functionScope.body) return false;
      let found = false;
      const inspect = child => {
        if (found || child !== functionScope.body && ts.isFunctionLike(child)) return;
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) &&
          child.expression.text === name && child.end <= node.pos) {
          found = true;
          return;
        }
        ts.forEachChild(child, inspect);
      };
      inspect(functionScope.body);
      return found;
    };
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
        if (child !== scope && ts.isFunctionLike(child) &&
          (callableShadows(child) || !calledBeforeUse(child))) return;
        if (child !== scope && (ts.isClassDeclaration(child) || ts.isClassExpression(child))) return;
        if (child !== scope && (ts.isBlock(child) && blockDeclares(child) ||
          ts.isCatchClause(child) && child.variableDeclaration && hasBindingName(child.variableDeclaration.name) ||
          loopDeclares(child))) {
          return;
        }
        if (ts.isVariableDeclaration(child) && hasBindingName(child.name)) {
          found = true;
          if (child.initializer) sources.push(child.initializer);
        }
        if (ts.isBinaryExpression(child) && [ts.SyntaxKind.EqualsToken,
          ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken,
          ts.SyntaxKind.AmpersandAmpersandEqualsToken].includes(child.operatorToken.kind)) {
          const left = unwrap(child.left);
          if (ts.isIdentifier(left) && left.text === name) {
            found = true;
            sources.push(child.right);
          }
        }
        ts.forEachChild(child, collect);
      };
      collect(scope);
      if (scope === functionScope.body) {
        for (const parameter of functionScope.parameters || []) {
          if (!hasBindingName(parameter.name)) continue;
          found = true;
          if (parameter.initializer) sources.push(parameter.initializer);
        }
      }
      if (found) return { sources };
    }
    return null;
  };

  const BOUND_PROBE = 'bound-process-probe';
  const GLOBAL_OBJECT = 'global-object';
  const staticCondition = (expression, currentPath, visited = new Set()) => {
    const node = unwrap(expression);
    if (!node) return null;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const value = staticCondition(node.operand, currentPath, visited);
      return value === null ? null : !value;
    }
    if (!ts.isIdentifier(node)) return null;
    const bindingKey = `${currentPath}:${node.text}`;
    if (visited.has(bindingKey)) return null;
    const bindings = modules.get(currentPath)?.bindings.get(node.text) || [];
    if (!bindings.length) return null;
    const nextVisited = new Set(visited).add(bindingKey);
    const values = bindings.map(binding => staticCondition(binding, currentPath, nextVisited));
    return values.every(value => value === true) ? true
      : values.every(value => value === false) ? false
        : null;
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
    if (ts.isObjectLiteralExpression(node)) {
      return new Set([{ objectLiteral: node, modulePath: currentPath }]);
    }
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
      const condition = staticCondition(node.condition, currentPath);
      if (condition !== null) {
        return evaluate(condition ? node.whenTrue : node.whenFalse, currentPath, seen,
          parameterBindings, bindingOverrides);
      }
      const result = evaluate(node.whenTrue, currentPath, seen, parameterBindings, bindingOverrides);
      for (const atom of evaluate(node.whenFalse, currentPath, seen, parameterBindings, bindingOverrides)) {
        result.add(atom);
      }
      return result;
    }
    if (ts.isIdentifier(node)) {
      const parameter = parameterBindings.get(node.text);
      if (parameter) {
        const result = new Set();
        if (parameter.name) {
          for (const atom of evaluateProperty(parameter.expression, parameter.name, parameter.currentPath,
            seen, bindingOverrides)) result.add(atom);
          if (parameter.parameterFallback) {
            for (const atom of evaluateProperty(parameter.parameterFallback, parameter.name,
              parameter.parameterFallbackPath, seen, bindingOverrides)) result.add(atom);
          }
        } else {
          for (const atom of evaluate(parameter.expression, parameter.currentPath, seen,
            parameter.bindings || new Map(), bindingOverrides)) result.add(atom);
        }
        if (parameter.fallback) {
          for (const atom of evaluate(parameter.fallback, parameter.fallbackPath || currentPath,
            seen, parameterBindings, bindingOverrides)) {
            result.add(atom);
          }
        }
        return result;
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
      if (node.text === 'globalThis' || node.text === 'global') return new Set([GLOBAL_OBJECT]);
      return result;
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = propertyName(node) || (ts.isElementAccessExpression(node)
        ? staticPropertyValue(node.argumentExpression, currentPath, seen) : null);
      if (!name) return new Set();
      const receiver = evaluate(node.expression, currentPath, seen, parameterBindings, bindingOverrides);
      const result = new Set();
      if (name === 'directPostOwnerAlive') result.add(LEGACY_OWNER);
      if (name === 'process' && receiver.has(GLOBAL_OBJECT)) result.add(PROCESS_OBJECT);
      if (name === 'kill' && receiver.has(PROCESS_OBJECT)) result.add(PID_PROBE);
      if (name === 'bind' && receiver.has(PID_PROBE)) result.add(BOUND_PROBE);
      for (const atom of receiver) {
        for (const nested of resolveProperty([atom], String(name), currentPath, seen)) result.add(nested);
      }
      return result;
    }
    if (ts.isNewExpression(node)) return resolveNew(
      evaluate(node.expression, currentPath, seen, parameterBindings), node.arguments || [], currentPath
    );
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'freeze' &&
        node.arguments[0] && isUnshadowedGlobalName(node.expression.expression, 'Object',
          currentPath && scanModule(currentPath))) {
        return evaluate(node.arguments[0], currentPath, seen, parameterBindings, bindingOverrides);
      }
      const callableAtoms = evaluate(node.expression, currentPath, seen, parameterBindings);
      const result = new Set();
      for (const atom of callableAtoms) {
        if (atom === BOUND_PROBE) {
          result.add((node.arguments || []).length > 1 ? BOUND_PROBE : PID_PROBE);
          continue;
        }
        if (!atom || !atom.callable) continue;
        const callablePath = atom.modulePath || currentPath;
        const nestedBindings = callableParameterBindings(atom.callable, node.arguments || [], currentPath, callablePath);
        for (const returnExpression of callableReturnExpressions(atom.callable)) {
          for (const returnAtom of evaluate(returnExpression, callablePath, seen, nestedBindings)) result.add(returnAtom);
        }
      }
      if (result.size) return result;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' &&
      ts.isStringLiteral(node.arguments[0])) {
      const currentModule = currentPath && scanModule(currentPath);
      const hasFunctionRequire = (() => {
        for (let ancestor = node.parent; ancestor && !ts.isSourceFile(ancestor); ancestor = ancestor.parent) {
          if (!ts.isFunctionLike(ancestor) || !ancestor.body || !ts.isBlock(ancestor.body)) continue;
          if (ancestor.parameters.some(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === 'require')) {
            return true;
          }
          for (const statement of ancestor.body.statements) {
            if (ts.isFunctionDeclaration(statement) && statement.name?.text === 'require') return true;
            if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(
              declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'require'
            )) return true;
          }
        }
        return false;
      })();
      if (currentModule?.bindings.has('require') || hasFunctionRequire) return new Set();
      const specifier = node.arguments[0].text;
      if (specifier === 'node:process' || specifier === 'process') return new Set([PROCESS_OBJECT]);
      const modulePath = currentPath && resolveRequest(currentPath, specifier);
      if (!modulePath) return new Set();
      const result = new Set([moduleAtom(modulePath)]);
      const module = scanModule(modulePath);
      for (const expression of module.defaultExports) {
        for (const atom of evaluate(expression, modulePath, seen)) result.add(atom);
      }
      return result;
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        return evaluate(node.right, currentPath, seen, parameterBindings, bindingOverrides);
      }
      if ([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
        const leftAtoms = evaluate(node.left, currentPath, seen, parameterBindings, bindingOverrides);
        const leftNode = unwrap(node.left);
        let truthy = leftAtoms.size ? true : null;
        let nullish = leftAtoms.size ? false : null;
        if (leftNode?.kind === ts.SyntaxKind.TrueKeyword) {
          truthy = true;
          nullish = false;
        } else if (leftNode?.kind === ts.SyntaxKind.FalseKeyword ||
          leftNode?.kind === ts.SyntaxKind.NullKeyword ||
          ts.isIdentifier(leftNode) && leftNode.text === 'undefined' || ts.isVoidExpression(leftNode)) {
          truthy = false;
          nullish = leftNode.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(leftNode) &&
            leftNode.text === 'undefined' || ts.isVoidExpression(leftNode);
        } else if (ts.isNumericLiteral(leftNode)) {
          truthy = Number(leftNode.text) !== 0;
          nullish = false;
        } else if (ts.isStringLiteral(leftNode) || ts.isNoSubstitutionTemplateLiteral(leftNode)) {
          truthy = leftNode.text.length > 0;
          nullish = false;
        } else if (ts.isFunctionExpression(leftNode) || ts.isArrowFunction(leftNode) ||
          ts.isClassExpression(leftNode) || ts.isObjectLiteralExpression(leftNode) ||
          ts.isArrayLiteralExpression(leftNode) || ts.isNewExpression(leftNode)) {
          truthy = true;
          nullish = false;
        }
        let includeLeft = true;
        let includeRight = true;
        if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
          if (truthy === true) includeRight = false;
          if (truthy === false) includeLeft = false;
        } else if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          if (truthy === true) includeLeft = false;
          if (truthy === false) includeRight = false;
        } else {
          if (nullish === false) includeRight = false;
          if (nullish === true) includeLeft = false;
        }
        const result = includeLeft ? leftAtoms : new Set();
        if (includeRight) {
          for (const atom of evaluate(node.right, currentPath, seen, parameterBindings, bindingOverrides)) {
            result.add(atom);
          }
        }
        return result;
      }
    }
    return new Set();
  };

  const resolveExportEquals = modulePath => {
    const module = scanModule(modulePath);
    if (!module) return new Set();
    const result = new Set();
    for (const expression of module.exportEqualsCandidates) {
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
    const commonJsValues = module.commonJsExports.get(String(name));
    const values = commonJsValues
      ? commonJsValues.filter(entry => entry.exportObject === module.currentExportObject).map(entry => entry.value)
      : module.exports.get(name) || [];
    const result = new Set();
    for (const value of values) {
      if (value && value.builtin === 'process') {
        result.add(value.name === 'kill' ? PID_PROBE : PROCESS_OBJECT);
      } else if (value && value.modulePath) {
        for (const atom of resolveExport(value.modulePath, value.name, seen)) result.add(atom);
      } else if (value && value.binding) {
        for (const atom of evaluateBinding(value.binding, module.path, seen)) result.add(atom);
      } else {
        for (const atom of evaluate(value, module.path, seen)) result.add(atom);
      }
    }
    if (!values.length && name !== 'default') {
      for (const expression of module.defaultExports) {
        for (const atom of evaluateProperty(expression, name, module.path, seen)) result.add(atom);
      }
    }
    if (name === 'default') {
      for (const expression of module.defaultExports) {
        for (const atom of evaluate(expression, module.path, seen)) result.add(atom);
      }
    }
    if (!values.length) {
      for (const wildcardPath of module.wildcardExports || []) {
        if (wildcardPath && wildcardPath.builtin === 'process') {
          result.add(name === 'kill' ? PID_PROBE : PROCESS_OBJECT);
        } else {
          for (const atom of resolveExport(wildcardPath, name, seen)) result.add(atom);
        }
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
      } else if (binding && binding.builtinNamespace === 'process') {
        result.add(PROCESS_OBJECT);
      } else if (ts.isObjectLiteralExpression(binding)) {
        result.add({ objectLiteral: binding, modulePath: currentPath });
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
      for (const expression of module.defaultExports) {
        for (const atom of evaluate(expression, modulePath, new Set())) result.add(atom);
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
        const parameterBindings = callableParameterBindings(atom.callable, argumentsList, callerPath, callablePath);
        for (const returnExpression of callableReturnExpressions(atom.callable)) {
          for (const returnAtom of evaluate(returnExpression, callablePath, visited, parameterBindings)) result.add(returnAtom);
        }
      }
      return result;
    },
    resolveCallEffects(atoms, argumentsList = [], callerPath = null) {
      const effects = [];
      for (const atom of atoms || []) {
        if (!atom || !atom.callable) continue;
        const writes = callableParameterWrites(atom.callable);
        if (!writes.length) continue;
        const callablePath = atom.modulePath || callerPath;
        const parameterBindings = callableParameterBindings(atom.callable, argumentsList, callerPath, callablePath);
        for (const write of writes) {
          const values = evaluate(write.expression, callablePath, new Set(), parameterBindings);
          if (values.size) effects.push({ parameterIndex: write.parameterIndex, name: write.name, values });
        }
      }
      return effects;
    },
    resolveExport,
    resolveProperty,
    resolveNew,
    modulePathFromAtom,
    moduleAtom
  };
}

module.exports = { createLocalModuleResolver, MODULE_OBJECT_PREFIX };
