'use strict';


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../..');

const EXPECTED_TRANSPORT = {
  'src/direct-post.ts': {
    verifyAgentDestination: 1,
    sendDiscordMessage: 1
  },
  // The destination lookup itself lives one owner deeper: direct-post.ts calls
  // verifyAgentDestination, which calls fetchDiscordChannel here. Pin the
  // primitive too, so a new unbracketed GET added at this layer fails.
  'src/direct-post/delivery-identity.ts': {
    fetchDiscordChannel: 1
  },
  'src/board-refresh.ts': {
    fetchBoardInstallation: 1,
    fetchBoardChannel: 1,
    fetchBoardTarget: 1,
    patchBoardMessage: 1
  }
};

// Files that must never call fetch directly. Peer service injects loadChannels,
// so a raw fetch there would bypass the bracketed lookup.
const NO_RAW_FETCH = new Set([
  ...Object.keys(EXPECTED_TRANSPORT),
  'src/peer/service.js',
  'src/peer/post.js'
]);

const REFUSAL = /native caller|peer caller|caller changed|caller has no active binding|caller binding is ambiguous|caller identity is unavailable|binding changed|binding is stale|aborted|closing/i;

function parse(fileName, text) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}

// Walk from a call expression to the nearest enclosing named function or method.
function enclosingOwner(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText();
    if (ts.isPropertyAssignment(current) && current.name &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.getText();
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer &&
      (ts.isFunctionExpression(current.initializer) || ts.isArrowFunction(current.initializer))) {
      return current.name.text;
    }
    if (ts.isClassDeclaration(current)) return null;
    current = current.parent;
  }
  return null;
}

function callSites(sourceFile, violations, reportedUnsupported, sources) {
  const sites = [];
  const logicalFile = sourceFile.fileName;
  const sourcePath = path.resolve(logicalFile);
  const compilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    types: [],
    target: ts.ScriptTarget.Latest
  };
  const roots = [sourcePath];
  const files = new Map([[sourcePath, sourceFile]]);
  const companion = 'src/direct-post/contracts.ts';
  if (logicalFile === 'src/direct-post.ts' && typeof sources[companion] === 'string') {
    const contractPath = path.resolve(companion);
    files.set(contractPath, parse(contractPath, sources[companion]));
    roots.push(contractPath);
  }
  const currentDirectory = path.resolve('.');
  const directories = new Set([currentDirectory]);
  for (const file of files.keys()) {
    let dir = path.dirname(file);
    while (!directories.has(dir)) {
      directories.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const host = {
    getSourceFile: name => files.get(path.resolve(name)),
    fileExists: name => files.has(path.resolve(name)),
    readFile: name => files.get(path.resolve(name))?.text,
    directoryExists: name => directories.has(path.resolve(name)),
    getDirectories: () => [],
    readDirectory: () => [],
    realpath: name => path.resolve(name),
    getCurrentDirectory: () => currentDirectory,
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: name => name,
    getNewLine: () => '\n',
    getEnvironmentVariable: () => '',
    writeFile: () => { throw new Error('inventory compiler host is read-only'); },
    resolveModuleNames: (names, importingFile) => names.map(name => {
      if (path.resolve(importingFile) !== sourcePath || name !== './direct-post/contracts' || roots.length !== 2) {
        return undefined;
      }
      return { resolvedFileName: roots[1], extension: ts.Extension.Ts };
    })
  };
  const program = ts.createProgram(roots, compilerOptions, host);
  const checker = program.getTypeChecker();
  const symbolAt = node => {
    if (!node) return null;
    if (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node) {
      return checker.getShorthandAssignmentValueSymbol(node.parent);
    }
    return checker.getSymbolAtLocation(node);
  };
  const unsupportedDefault = Symbol('unsupported stored callable');
  const incompleteReceiver = Symbol('unsupported receiver history');
  const bindingHistoryBySymbol = new Map();
  const recordBinding = (identifier, position, expression = null, canonical = null, expressionPosition = position, defaultedCapture = false) => {
    const symbol = symbolAt(identifier);
    if (!symbol) return;
    const entries = bindingHistoryBySymbol.get(symbol) || [];
    entries.push({ position, expression, expressionPosition, canonical, defaultedCapture, tracked: Boolean(expression || canonical) });
    entries.sort((left, right) => left.position - right.position);
    bindingHistoryBySymbol.set(symbol, entries);
  };
  const bindingAt = (identifier, position) => {
    let binding = null;
    for (const candidate of bindingHistoryBySymbol.get(symbolAt(identifier)) || []) {
      if (candidate.position < position) binding = candidate;
    }
    return binding;
  };
  const namedRuntimeExport = sourceFile.statements.some(statement =>
    ts.isExportDeclaration(statement) && !statement.isTypeOnly && !statement.moduleSpecifier &&
    statement.exportClause && ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.some(specifier => !specifier.isTypeOnly &&
      (specifier.propertyName || specifier.name).text === 'runDirectPost'));
  const inlineRuntimeExport = sourceFile.statements.some(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'runDirectPost' &&
    statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
  const exportedRunDirectPost = namedRuntimeExport || inlineRuntimeExport;
  const isExternalCallbackOption = (declaration, element) => {
    if (!ts.isIdentifier(element.name) || element.dotDotDotToken ||
        element.initializer.kind !== ts.SyntaxKind.NullKeyword) return false;
    const property = element.propertyName || element.name;
    if (!ts.isIdentifier(property) && !ts.isStringLiteral(property)) return false;
    const inventoried = name => name === 'fetch' || name === 'loadChannels' ||
      Object.values(EXPECTED_TRANSPORT).some(expected => Object.hasOwn(expected, name));
    if (inventoried(property.text) || inventoried(element.name.text)) return false;
    let input = declaration.initializer;
    while (input && (ts.isAsExpression(input) || ts.isParenthesizedExpression(input) || ts.isTypeAssertionExpression(input))) {
      input = input.expression;
    }
    if (!input || !ts.isIdentifier(input)) return false;
    const symbol = symbolAt(input);
    const parameter = symbol?.declarations?.length === 1 ? symbol.declarations[0] : null;
    const owner = parameter?.parent;
    if (!parameter || !ts.isParameter(parameter) || !ts.isIdentifier(parameter.name) ||
        !parameter.type || parameter.initializer || parameter.dotDotDotToken ||
        logicalFile !== 'src/direct-post.ts' || !ts.isFunctionDeclaration(owner) ||
        owner.name?.text !== 'runDirectPost' || owner.parent !== sourceFile ||
        owner.parameters.length !== 1 || owner.parameters[0] !== parameter || !exportedRunDirectPost) return false;
    const typeReference = parameter.type;
    if (!ts.isTypeReferenceNode(typeReference) || !ts.isIdentifier(typeReference.typeName)) return false;
    const importedType = checker.getSymbolAtLocation(typeReference.typeName);
    const directPostInput = importedType && (importedType.flags & ts.SymbolFlags.Alias)
      ? checker.getAliasedSymbol(importedType)
      : importedType;
    if (!directPostInput || directPostInput.name !== 'DirectPostInput' ||
        !directPostInput.declarations?.some(typeDeclaration =>
          path.resolve(typeDeclaration.getSourceFile().fileName) === path.resolve(companion))) return false;
    const receiverType = checker.getTypeFromTypeNode(typeReference);
    const variants = receiverType.isUnion() ? receiverType.types : [receiverType];
    const callableProperty = variant => {
      if (!(variant.flags & ts.TypeFlags.Object)) return false;
      const field = checker.getPropertyOfType(variant, property.text);
      if (!field || !field.declarations?.length) return false;
      const nullableContractType = type => {
        if (ts.isParenthesizedTypeNode(type)) return nullableContractType(type.type);
        if (ts.isUnionTypeNode(type)) return type.types.some(nullableContractType);
        return type.kind === ts.SyntaxKind.UndefinedKeyword ||
          (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword);
      };
      const optionalOrNullableContract = field.declarations.every(fieldDeclaration => {
        if (!ts.isPropertySignature(fieldDeclaration) || !fieldDeclaration.type) return false;
        return Boolean(fieldDeclaration.questionToken) || nullableContractType(fieldDeclaration.type);
      });
      if (!optionalOrNullableContract) return false;
      const value = checker.getTypeOfSymbolAtLocation(field, parameter.name);
      const alternatives = (value.isUnion() ? value.types : [value]).filter(type =>
        !(type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
      return alternatives.length > 0 && alternatives.every(type =>
        !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) &&
        checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0);
    };
    if (!variants.every(callableProperty)) return false;
    const otherUse = node => {
      if (ts.isIdentifier(node) && node !== parameter.name && node !== input && symbolAt(node) === symbol) return true;
      return ts.forEachChild(node, otherUse);
    };
    return !otherUse(parameter.parent);
  };
  const collectBindings = node => {
    if (ts.isImportSpecifier(node)) {
      recordBinding(node.name, -Infinity, null, (node.propertyName || node.name).text);
    } else if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name)) {
      recordBinding(node.name, node.getStart(sourceFile), node.initializer || null);
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      const property = node.propertyName || node.name;
      const declaration = node.parent.parent;
      if (ts.isBindingElement(declaration)) {
        let outer = declaration;
        let defaulted = Boolean(node.initializer);
        while (ts.isBindingElement(outer)) {
          defaulted ||= Boolean(outer.initializer);
          outer = outer.parent.parent;
        }
        if (defaulted && ts.isVariableDeclaration(outer)) {
          recordBinding(node.name, node.getStart(sourceFile), null, incompleteReceiver);
          ts.forEachChild(node, collectBindings);
          return;
        }
      }
      const receiver = ts.isObjectBindingPattern(node.parent) && ts.isVariableDeclaration(declaration) &&
        declaration.initializer && ts.isIdentifier(declaration.initializer) && !node.dotDotDotToken
        ? declaration.initializer
        : null;
      const position = node.getStart(sourceFile);
      if (node.initializer && ts.isObjectBindingPattern(node.parent) && ts.isVariableDeclaration(declaration) &&
          !isExternalCallbackOption(declaration, node)) {
        const history = receiver && objectHistoryAt(symbolAt(receiver), position);
        const properties = objectPropertiesAt(history, position);
        const staticKey = ts.isIdentifier(property) || ts.isStringLiteral(property);
        const complete = history && history.unsupportedFrom > position && properties && staticKey;
        const stored = complete ? properties.get(property.text) : null;
        if (!complete) {
          recordBinding(node.name, position, null, incompleteReceiver);
        } else if (!stored || ts.isVoidExpression(stored)) {
          recordBinding(node.name, position, node.initializer, null, position, true);
        } else {
          recordBinding(node.name, position, stored, null, stored.getStart(sourceFile), true);
        }
        ts.forEachChild(node, collectBindings);
        return;
      }
      const captured = receiver && (ts.isIdentifier(property) || ts.isStringLiteral(property))
        ? objectPropertyAt(receiver, property.text, node.getStart(sourceFile))
        : null;
      const canonical = !captured && ts.isIdentifier(property) ? property.text : null;
      recordBinding(node.name, node.getStart(sourceFile), captured || node.initializer || null, canonical,
        captured ? captured.getStart(sourceFile) : node.getStart(sourceFile));
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      recordBinding(node.name, -Infinity);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)) {
      recordBinding(node.left, node.getStart(sourceFile), node.right);
    }
    ts.forEachChild(node, collectBindings);
  };

  const protectedImport = (identifier, name) => {
    if (!Object.values(EXPECTED_TRANSPORT).some(expected => Object.hasOwn(expected, name))) return false;
    const declarations = symbolAt(identifier)?.declarations || [];
    return declarations.some(declaration => {
      if (ts.isImportSpecifier(declaration)) return !declaration.isTypeOnly && !declaration.parent.parent.isTypeOnly;
      if (!ts.isBindingElement(declaration) || declaration.initializer) return false;
      const variable = declaration.parent.parent;
      if (!ts.isVariableDeclaration(variable)) return false;
      let initializer = variable.initializer;
      if (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression;
      return !!initializer && ts.isCallExpression(initializer) && ts.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'require' && !symbolAt(initializer.expression)?.declarations?.length &&
        initializer.arguments.length === 1 && ts.isStringLiteral(initializer.arguments[0]) &&
        checker.getTypeAtLocation(identifier).getCallSignatures().length > 0;
    });
  };
  const canonicalForExpression = (expression, position = expression?.getStart(sourceFile), resolving = new Set(),
                                  representedOnly = false) => {
    if (!expression) return representedOnly ? unsupportedDefault : null;
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(expression);
      if (!symbol || !symbol.declarations?.length) return representedOnly ? unsupportedDefault : expression.text;
      const binding = bindingAt(expression, position);
      if (!binding || resolving.has(binding)) return representedOnly ? unsupportedDefault : null;
      if (!binding.expression) {
        if (!representedOnly || binding.canonical === unsupportedDefault || binding.canonical === incompleteReceiver) return binding.canonical;
        if (binding.canonical && protectedImport(expression, binding.canonical)) return binding.canonical;
        if (binding.position === -Infinity && symbol.declarations.some(ts.isFunctionDeclaration)) return null;
        return unsupportedDefault;
      }
      const next = new Set(resolving);
      next.add(binding);
      return canonicalForExpression(binding.expression, binding.expressionPosition, next,
        representedOnly || binding.defaultedCapture);
    }
    if (representedOnly) {
      if (ts.isFunctionExpression(expression) || ts.isArrowFunction(expression)) return null;
      return unsupportedDefault;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const object = canonicalForExpression(expression.expression, position, resolving);
      if (object === unsupportedDefault || object === incompleteReceiver) return object;
      return object ? `${object}.${expression.name.text}` : null;
    }
    if (ts.isElementAccessExpression(expression)) {
      const object = canonicalForExpression(expression.expression, position, resolving);
      if (object === unsupportedDefault || object === incompleteReceiver) return object;
      const argument = expression.argumentExpression;
      if (object === 'globalThis' && argument && ts.isStringLiteral(argument)) return argument.text;
      return null;
    }
    return null;
  };
  const objectHistoryBySymbol = new Map();
  const objectHistoryAt = (symbol, position) => {
    let history = null;
    for (const candidate of objectHistoryBySymbol.get(symbol) || []) {
      if (candidate.position < position) history = candidate.history;
    }
    return history;
  };
  const associateObjectHistory = (symbol, position, history) => {
    if (!symbol || !history) return;
    const entries = objectHistoryBySymbol.get(symbol) || [];
    entries.push({ position, history });
    entries.sort((left, right) => left.position - right.position);
    objectHistoryBySymbol.set(symbol, entries);
  };
  const objectPropertiesAt = (history, position) => {
    let properties = null;
    for (const candidate of history?.entries || []) {
      if (candidate.position < position) properties = candidate.properties;
    }
    return properties;
  };
  const recordObjectProperties = (history, position, properties) => {
    if (!history) return;
    history.entries.push({ position, properties });
    history.entries.sort((left, right) => left.position - right.position);
  };
  const objectPropertyAt = (receiver, property, position) => {
    const history = objectHistoryAt(symbolAt(receiver), position);
    return objectPropertiesAt(history, position)?.get(property) || null;
  };
  const collectObjectLiterals = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const properties = new Map();
      let complete = true;
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property)) {
          const propertyName = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? property.name.text
            : null;
          if (!propertyName || propertyName === '__proto__') complete = false;
          if (propertyName) properties.set(propertyName, property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          properties.set(property.name.text, property.name);
        } else {
          complete = false;
        }
      }
      const history = { entries: [], unsupportedFrom: complete ? Infinity : node.getStart(sourceFile) };
      recordObjectProperties(history, node.getStart(sourceFile), properties);
      associateObjectHistory(symbolAt(node.name), node.getStart(sourceFile), history);
    }
    ts.forEachChild(node, collectObjectLiterals);
  };
  const collectObjectAliases = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.initializer && ts.isIdentifier(node.initializer)) {
      const history = objectHistoryAt(symbolAt(node.initializer), node.getStart(sourceFile));
      associateObjectHistory(symbolAt(node.name), node.getStart(sourceFile), history);
    }
    ts.forEachChild(node, collectObjectAliases);
  };
  const collectObjectPropertyWrites = node => {
    if (ts.isIdentifier(node)) {
      const position = node.getStart(sourceFile);
      const history = objectHistoryAt(symbolAt(node), position);
      if (history) {
        const parent = node.parent;
        const aliasOrExtraction = ts.isVariableDeclaration(parent) && parent.initializer === node &&
          (ts.isIdentifier(parent.name) || ts.isObjectBindingPattern(parent.name));
        const ownDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
        const member = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
        const assignment = member && parent.parent;
        const plainWrite = assignment && ts.isBinaryExpression(assignment) && assignment.left === parent &&
          assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          (ts.isPropertyAccessExpression(parent) || ts.isStringLiteral(parent.argumentExpression)) &&
          ts.isExpressionStatement(assignment.parent) && ts.isSourceFile(assignment.parent.parent);
        if (!aliasOrExtraction && !ownDeclaration && !plainWrite) {
          history.unsupportedFrom = Math.min(history.unsupportedFrom, position);
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
      const receiver = node.left.expression;
      const argument = ts.isElementAccessExpression(node.left) ? node.left.argumentExpression : null;
      const property = ts.isPropertyAccessExpression(node.left)
        ? node.left.name.text
        : argument && ts.isStringLiteral(argument) ? argument.text : null;
      if (ts.isIdentifier(receiver) && property) {
        const history = objectHistoryAt(symbolAt(receiver), node.getStart(sourceFile));
        const previous = objectPropertiesAt(history, node.getStart(sourceFile));
        if (previous) {
          const properties = new Map(previous);
          properties.set(property, node.right);
          recordObjectProperties(history, node.getStart(sourceFile), properties);
        }
      }
    }
    ts.forEachChild(node, collectObjectPropertyWrites);
  };
  collectObjectLiterals(sourceFile);
  collectObjectAliases(sourceFile);
  collectObjectPropertyWrites(sourceFile);
  collectBindings(sourceFile);
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      let canonical = null;
      let name = null;
      let indirect = false;
      if (ts.isIdentifier(expression)) {
        name = expression.text;
        const binding = bindingAt(expression, node.getStart(sourceFile));
        canonical = canonicalForExpression(expression);
        indirect = Boolean(binding?.tracked);
      } else if (ts.isPropertyAccessExpression(expression)) {
        name = expression.name.text;
        if (name === 'call' || name === 'apply') {
          canonical = canonicalForExpression(expression.expression);
          indirect = true;
        } else {
          const receiver = expression.expression;
          const initializer = ts.isIdentifier(receiver)
            ? objectPropertyAt(receiver, name, node.getStart(sourceFile))
            : null;
          if (initializer && ts.isIdentifier(initializer)) {
            canonical = canonicalForExpression(initializer);
            indirect = true;
          } else {
            canonical = name;
          }
        }
      } else if (ts.isElementAccessExpression(expression)) {
        const receiver = expression.expression;
        const argument = expression.argumentExpression;
        const property = argument && ts.isStringLiteral(argument) ? argument.text : null;
        const initializer = property && ts.isIdentifier(receiver)
          ? objectPropertyAt(receiver, property, node.getStart(sourceFile))
          : null;
        if (initializer && ts.isIdentifier(initializer)) {
          name = property;
          canonical = canonicalForExpression(initializer);
          indirect = true;
        } else {
          indirect = true;
          name = expression.getText(sourceFile);
          canonical = canonicalForExpression(expression);
        }
      }
      if (name) {
        const reason = canonical === incompleteReceiver ? 'receiver history is incomplete' :
          canonical === unsupportedDefault ? 'callable identity is not represented' : null;
        let unsupportedDefaultDiagnostic = null;
        if (reason) {
          const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const callee = ts.isPropertyAccessExpression(expression) && (name === 'call' || name === 'apply')
            ? expression.expression : expression;
          const calledName = ts.isIdentifier(callee) ? callee.text :
            ts.isPropertyAccessExpression(callee) ? callee.name.text : '<computed>';
          unsupportedDefaultDiagnostic = `${logicalFile}:${line + 1}:${character + 1}: unsupported defaulted capture '${calledName}': ${reason}`;
        }
        if (unsupportedDefaultDiagnostic) {
          if (!reportedUnsupported.has(unsupportedDefaultDiagnostic)) {
            reportedUnsupported.add(unsupportedDefaultDiagnostic);
            violations.push(unsupportedDefaultDiagnostic);
          }
        } else {
          sites.push({ node, name, canonical, indirect, owner: enclosingOwner(node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  for (const statement of sourceFile.statements) visit(statement);
  return sites;
}

// Names bound to a createCallerAssertion(...) result in one source file.
function assertionFactoryNames(sourceFile) {
  const names = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'createCallerAssertion') {
      if (ts.isIdentifier(node.name)) names.push(node.name.text);
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) names.push(element.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function hasFactoryCall(sites) {
  return sites.some(site => site.canonical === 'createCallerAssertion');
}

// Resolve an object literal's named properties, following identifier spreads of
// other object-literal variable declarations one level deep.
function objectProperties(expression, variableInitializers) {
  const properties = new Map();
  if (!expression || !ts.isObjectLiteralExpression(expression)) return properties;
  for (const property of expression.properties) {
    if (ts.isPropertyAssignment(property) && property.name) {
      properties.set(property.name.getText().replace(/['"]/g, ''), property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      properties.set(property.name.getText(), property.name);
    } else if (ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)) {
      const spread = objectProperties(variableInitializers.get(property.expression.text), variableInitializers);
      for (const [key, value] of spread) if (!properties.has(key)) properties.set(key, value);
    }
  }
  return properties;
}

function variableInitializers(sourceFile) {
  const initializers = new Map();
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializers;
}

function referencesRequestField(initializer) {
  if (!initializer) return true;
  const text = initializer.getText();
  return /\b(input|args|request)\s*\./.test(text) || /\[\s*['"]assertCallerCurrent['"]\s*\]/.test(text) ||
    /objectAssign|Object\.assign/.test(text);
}

// A property that is written as null or undefined is treated as absent.
function suppliesValue(initializer) {
  if (!initializer) return false;
  if (initializer.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(initializer) && initializer.text === 'undefined') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Inventory checkers. Each returns an array of human-readable violations.

function transportViolations(sources, reportedUnsupported) {
  const violations = [];
  for (const [file, expected] of Object.entries(EXPECTED_TRANSPORT)) {
    const text = sources[file];
    if (typeof text !== 'string') {
      violations.push(`${file}: source is missing`);
      continue;
    }
    const sourceFile = parse(file, text);
    const counts = new Map();
    for (const site of callSites(sourceFile, violations, reportedUnsupported, sources)) {
      if (site.canonical === 'fetch' || site.name === 'fetch' ||
          (ts.isPropertyAccessExpression(site.node.expression) && site.name === 'fetch')) {
        violations.push(`${file}: direct fetch call at ${site.owner || '<top>'}`);
      }
      if (Object.hasOwn(expected, site.canonical)) {
        counts.set(site.canonical, (counts.get(site.canonical) || 0) + 1);
      }
    }
    for (const [name, wanted] of Object.entries(expected)) {
      const got = counts.get(name) || 0;
      if (got !== wanted) violations.push(`${file}: ${name} expected ${wanted}, found ${got}`);
    }
    // A transport import that is not part of the pinned inventory is a new site.
    const visit = node => {
      if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings)) {
        const specifier = node.moduleSpecifier.getText();
        if (/discord|delivery-identity|direct-post/.test(specifier)) {
          for (const element of node.importClause.namedBindings.elements) {
            if (element.isTypeOnly) continue;
            const canonical = (element.propertyName || element.name).text;
            if (!Object.hasOwn(expected, canonical) && /fetch|send|patch|Destination/i.test(canonical)) {
              violations.push(`${file}: unexpected transport import ${canonical} from ${specifier}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  // Raw fetch must not appear in any owner that is expected to route through
  // an inventoried transport helper, including peer service (which injects
  // loadChannels) and post.
  for (const file of NO_RAW_FETCH) {
    if (Object.hasOwn(EXPECTED_TRANSPORT, file)) continue;
    const text = sources[file];
    if (typeof text !== 'string') {
      violations.push(`${file}: source is missing`);
      continue;
    }
    for (const site of callSites(parse(file, text), violations, reportedUnsupported, sources)) {
      if (site.name === 'fetch') violations.push(`${file}: direct fetch call at ${site.owner || '<top>'}`);
    }
  }
  return violations;
}

function serverFetchViolations(sources, reportedUnsupported) {
  const file = 'src/peer/server.js';
  const text = sources[file];
  if (typeof text !== 'string') return [`${file}: source is missing`];
  const violations = [];
  const sites = callSites(parse(file, text), violations, reportedUnsupported, sources)
    .filter(site => site.canonical === 'fetch' || site.name === 'fetch');
  if (sites.length !== 1) violations.push(`${file}: fetch expected 1, found ${sites.length}`);
  for (const site of sites) {
    if (site.owner !== 'loadChannels') violations.push(`${file}: fetch outside loadChannels at ${site.owner || '<top>'}`);
  }
  return violations;
}

function channelLookupViolations(sources, reportedUnsupported) {
  const violations = [];
  const text = sources['src/peer/service.js'];
  if (typeof text !== 'string') {
    violations.push('src/peer/service.js: source is missing');
    return violations;
  }
  const sourceFile = parse('src/peer/service.js', text);
  const sites = callSites(sourceFile, violations, reportedUnsupported, sources);
  const lookups = sites.filter(site => site.canonical === 'loadChannels');
  if (lookups.length !== 1) violations.push(`src/peer/service.js: loadChannels expected 1, found ${lookups.length}`);
  const factoryNames = new Set(assertionFactoryNames(sourceFile));
  factoryNames.add('assertCallerCurrent');
  const assertions = sites.filter(site => factoryNames.has(site.name) || factoryNames.has(site.canonical));
  if (!hasFactoryCall(sites)) violations.push('src/peer/service.js: no createCallerAssertion call found');
  if (lookups.length === 1) {
    const lookup = lookups[0].node;
    const before = assertions.some(site => site.node.pos < lookup.pos && site.owner === lookups[0].owner);
    const after = assertions.some(site => site.node.end > lookup.end && site.owner === lookups[0].owner);
    if (!before) violations.push('src/peer/service.js: no caller assertion before loadChannels');
    if (!after) violations.push('src/peer/service.js: no caller assertion after loadChannels');
  }
  return violations;
}

// Public peer roles must forward the assertion produced by the peer caller owner.
function wiringViolations(sources, reportedUnsupported = new Set()) {
  const violations = [];
  for (const file of ['src/peer/service.js', 'src/peer/post.js']) {
    const text = sources[file];
    if (typeof text !== 'string') {
      violations.push(`${file}: source is missing`);
      continue;
    }
    const sourceFile = parse(file, text);
    const initializers = variableInitializers(sourceFile);
    const factoryNames = new Set(assertionFactoryNames(sourceFile));
    const sites = callSites(sourceFile, violations, reportedUnsupported, sources);
    if (!hasFactoryCall(sites)) violations.push(`${file}: no createCallerAssertion call found`);
    const runCalls = sites.filter(site =>
      site.canonical === 'runDirectPost' || site.canonical === 'runBoardRefresh');
    if (file.endsWith('service.js')) {
      const sendRun = runCalls.filter(site => site.owner === 'send');
      if (sendRun.length !== 1) violations.push('src/peer/service.js: send must call runDirectPost exactly once');
      for (const site of sendRun) {
        const properties = objectProperties(site.node.arguments[0], initializers);
        const value = properties.get('assertCallerCurrent');
        if (!suppliesValue(value)) violations.push('src/peer/service.js: send does not supply assertCallerCurrent');
        else if (referencesRequestField(value)) violations.push('src/peer/service.js: assertCallerCurrent comes from request fields');
        else if (!(ts.isIdentifier(value) && factoryNames.has(value.text)) &&
                 !(ts.isCallExpression(value) && calleeName(value) === 'createCallerAssertion')) {
          violations.push('src/peer/service.js: assertCallerCurrent is not derived from createCallerAssertion');
        }
      }
    } else {
      const announce = runCalls.filter(site => site.owner === 'postByRole');
      const board = announce.filter(site => site.canonical === 'runBoardRefresh');
      const direct = announce.filter(site => site.canonical === 'runDirectPost');
      if (direct.length !== 1) violations.push('src/peer/post.js: postByRole must call announcement runDirectPost exactly once');
      if (board.length !== 1) violations.push('src/peer/post.js: postByRole must call runBoardRefresh exactly once');
      for (const site of [...direct, ...board]) {
        const properties = objectProperties(site.node.arguments[0], initializers);
        const value = properties.get('assertCallerCurrent');
        if (!suppliesValue(value)) violations.push(`src/peer/post.js: ${site.canonical} does not receive assertCallerCurrent`);
        else if (referencesRequestField(value)) violations.push(`src/peer/post.js: ${site.canonical} assertion comes from request fields`);
        else if (!(ts.isIdentifier(value) && factoryNames.has(value.text)) &&
                 !(ts.isCallExpression(value) && calleeName(value) === 'createCallerAssertion')) {
          violations.push(`src/peer/post.js: ${site.canonical} assertion is not derived from createCallerAssertion`);
        }
      }
    }
    // bindingCurrent and agentDestinationCurrent stay synchronous.
    const visit = node => {
      if (ts.isPropertyAssignment(node) && node.name && ['bindingCurrent', 'agentDestinationCurrent'].includes(node.name.getText())) {
        const initializer = node.initializer;
        if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
          if (initializer.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
            violations.push(`${file}: ${node.name.getText()} must remain synchronous`);
          }
          const containsAwait = node => {
            if (ts.isAwaitExpression(node)) return true;
            return ts.forEachChild(node, containsAwait) || false;
          };
          if (containsAwait(initializer)) violations.push(`${file}: ${node.name.getText()} must not await`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const revalidation = sources['test/peer-effect-revalidation.test.js'];
  if (typeof revalidation !== 'string') violations.push('test/peer-effect-revalidation.test.js: source is missing');
  else if (/FIXED|PEER_EFFECT_EXPECT_FIXED|transitional\s*\(/.test(revalidation)) {
    violations.push('test/peer-effect-revalidation.test.js: still contains a transitional expected-red mode');
  }
  return violations;
}

function realSources() {
  const files = [
    'src/direct-post.ts', 'src/direct-post/contracts.ts', 'src/direct-post/delivery-identity.ts', 'src/board-refresh.ts',
    'src/peer/service.js', 'src/peer/server.js', 'src/peer/post.js', 'test/peer-effect-revalidation.test.js'
  ];
  return Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
}

function rejectionViolations(sources) {
  const counts = { 'src/peer/service.js': 1, 'src/direct-post.ts': 2, 'src/board-refresh.ts': 4 };
  const violations = [];
  for (const [file, expected] of Object.entries(counts)) {
    const tree = parse(file, sources[file]);
    const nullable = new Set();
    const owners = new Map();
    let constructors = 0;
    function declarations(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (node.initializer?.kind === ts.SyntaxKind.NullKeyword) nullable.add(node.name.text);
        if (node.initializer && ts.isNewExpression(node.initializer) &&
            node.initializer.expression.getText(tree) === 'TransportRejection') {
          if (owners.has(node.name.text)) violations.push(`${file}: duplicate rejection owner ${node.name.text}`);
          owners.set(node.name.text, 0);
        }
      }
      if (ts.isNewExpression(node) && node.expression.getText(tree) === 'TransportRejection') constructors += 1;
      ts.forEachChild(node, declarations);
    }
    declarations(tree);
    function visit(node) {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(node.left) && nullable.has(node.left.text) && ts.isIdentifier(node.right)) {
        let parent = node.parent;
        while (parent && !ts.isCatchClause(parent) && !ts.isFunctionLike(parent)) parent = parent.parent;
        if (parent && ts.isCatchClause(parent) && parent.variableDeclaration?.name.getText(tree) === node.right.text) {
          violations.push(`${file}: nullable rejection sentinel ${node.left.text}`);
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) && node.expression.name.text === 'capture' &&
          owners.has(node.expression.expression.text)) {
        const owner = node.expression.expression.text;
        owners.set(owner, owners.get(owner) + 1);
        let parent = node.parent;
        while (parent && !ts.isCatchClause(parent) && !ts.isFunctionLike(parent)) parent = parent.parent;
        const binding = parent && ts.isCatchClause(parent) ? parent.variableDeclaration?.name : undefined;
        if (!binding || !ts.isIdentifier(binding) || node.arguments.length !== 1 ||
            !ts.isIdentifier(node.arguments[0]) || node.arguments[0].text !== binding.text) {
          violations.push(`${file}: ${owner} must capture its raw catch value`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    if (constructors !== expected || owners.size !== expected) {
      violations.push(`${file}: expected ${expected} rejection owners, found ${constructors} constructors and ${owners.size} bindings`);
    }
    for (const [owner, captures] of owners) {
      if (captures !== 1) violations.push(`${file}: ${owner} must capture exactly once, found ${captures}`);
    }
  }
  return violations;
}

function ownerViolations(sources) {
  const reportedUnsupported = new Set();
  return [
    ...transportViolations(sources, reportedUnsupported),
    ...serverFetchViolations(sources, reportedUnsupported),
    ...channelLookupViolations(sources, reportedUnsupported),
    ...wiringViolations(sources, reportedUnsupported),
    ...rejectionViolations(sources)
  ];
}


module.exports = { rejectionViolations, wiringViolations, realSources, ownerViolations, REFUSAL };
