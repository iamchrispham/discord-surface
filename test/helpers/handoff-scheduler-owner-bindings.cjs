'use strict';

function createOwnerBindings({ ts, source, timerApiNames, unwrapParentheses }) {
  function bindingContainsName(bindingName, soughtName) {
      if (ts.isIdentifier(bindingName)) return bindingName.text === soughtName;
      if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
        return bindingName.elements.some(element => ts.isBindingElement(element) &&
          bindingContainsName(element.name, soughtName));
      }
      return false;
    }

  function declarationListContainsName(declarations, soughtName, blockScopedOnly = false) {
      if (blockScopedOnly && (declarations.flags & ts.NodeFlags.BlockScoped) === 0) return false;
      return declarations.declarations.some(declaration => bindingContainsName(declaration.name, soughtName));
    }

  function statementsContainName(statements, soughtName, blockScopedOnly = false) {
      return statements.some(statement => {
        if (ts.isVariableStatement(statement)) {
          return declarationListContainsName(statement.declarationList, soughtName, blockScopedOnly);
        }
        if (blockScopedOnly && !ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement)) return false;
        return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
          statement.name && ts.isIdentifier(statement.name) && statement.name.text === soughtName;
      });
    }

  function functionHasVarBinding(functionNode, soughtName) {
      if (!functionNode.body) return false;
      let found = false;
      function scan(node) {
        if (node !== functionNode.body && (ts.isFunctionLike(node) ||
          ts.isClassDeclaration(node) || ts.isClassExpression(node))) return;
        if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) &&
          (node.parent.flags & ts.NodeFlags.BlockScoped) === 0 && bindingContainsName(node.name, soughtName)) {
          found = true;
          return;
        }
        ts.forEachChild(node, scan);
      }
      scan(functionNode.body);
      return found;
    }

  function sourceFileContainsName(sourceNode, soughtName) {
      return sourceNode.statements.some(statement => {
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (!clause) return false;
          if (clause.name?.text === soughtName) return true;
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) return bindings.name.text === soughtName;
          return Boolean(bindings && ts.isNamedImports(bindings) &&
            bindings.elements.some(element => element.name.text === soughtName));
        }
        if (ts.isImportEqualsDeclaration(statement)) return statement.name.text === soughtName;
        if (ts.isVariableStatement(statement)) {
          return declarationListContainsName(statement.declarationList, soughtName);
        }
        return (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
          statement.name && ts.isIdentifier(statement.name) && statement.name.text === soughtName;
      });
    }

  function scopeDeclaresTimerName(scope, soughtName) {
      if (ts.isFunctionLike(scope)) {
        if (scope.parameters.some(parameter => bindingContainsName(parameter.name, soughtName)) ||
          (ts.isFunctionExpression(scope) && scope.name?.text === soughtName) ||
          functionHasVarBinding(scope, soughtName)) return true;
      }
      if (ts.isBlock(scope) && statementsContainName(scope.statements, soughtName, true)) return true;
      if (ts.isCaseBlock(scope) && scope.clauses.some(clause =>
        statementsContainName(clause.statements, soughtName, true))) return true;
      if (ts.isCatchClause(scope) && scope.variableDeclaration &&
        bindingContainsName(scope.variableDeclaration.name, soughtName)) return true;
      if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
        scope.initializer && ts.isVariableDeclarationList(scope.initializer) &&
        declarationListContainsName(scope.initializer, soughtName)) return true;
      return ts.isSourceFile(scope) && sourceFileContainsName(scope, soughtName);
    }

  function bindingIdentifier(bindingName, soughtName) {
      if (ts.isIdentifier(bindingName)) return bindingName.text === soughtName ? bindingName : null;
      if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
        for (const element of bindingName.elements) {
          if (!ts.isBindingElement(element)) continue;
          const match = bindingIdentifier(element.name, soughtName);
          if (match) return match;
        }
      }
      return null;
    }

  function variableBinding(declarations, soughtName, blockScopedOnly = false) {
      if (blockScopedOnly && (declarations.flags & ts.NodeFlags.BlockScoped) === 0) return null;
      for (const declaration of declarations.declarations) {
        const match = bindingIdentifier(declaration.name, soughtName);
        if (match) return match;
      }
      return null;
    }

  function statementBinding(statements, soughtName, blockScopedOnly = false) {
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)) {
          const match = variableBinding(statement.declarationList, soughtName, blockScopedOnly);
          if (match) return match;
          continue;
        }
        if (blockScopedOnly && !ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement)) continue;
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name) {
          const match = bindingIdentifier(statement.name, soughtName);
          if (match) return match;
        }
      }
      return null;
    }

  function functionVarBinding(functionNode, soughtName) {
      if (!functionNode.body) return null;
      let found = null;
      function scan(node) {
        if (found || (node !== functionNode.body && (ts.isFunctionLike(node) ||
          ts.isClassDeclaration(node) || ts.isClassExpression(node)))) return;
        if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) &&
          (node.parent.flags & ts.NodeFlags.BlockScoped) === 0) {
          found = bindingIdentifier(node.name, soughtName);
          if (found) return;
        }
        ts.forEachChild(node, scan);
      }
      scan(functionNode.body);
      return found;
    }

  function scopeBinding(scope, soughtName) {
      if (ts.isFunctionLike(scope)) {
        for (const parameter of scope.parameters) {
          const match = bindingIdentifier(parameter.name, soughtName);
          if (match) return match;
        }
        if (ts.isFunctionExpression(scope) && scope.name?.text === soughtName) return scope.name;
        return functionVarBinding(scope, soughtName);
      }
      if (ts.isBlock(scope)) return statementBinding(scope.statements, soughtName, true);
      if (ts.isCaseBlock(scope)) {
        for (const clause of scope.clauses) {
          const match = statementBinding(clause.statements, soughtName, true);
          if (match) return match;
        }
      }
      if (ts.isCatchClause(scope) && scope.variableDeclaration) {
        const match = bindingIdentifier(scope.variableDeclaration.name, soughtName);
        if (match) return match;
      }
      if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) &&
        scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
        const match = variableBinding(scope.initializer, soughtName);
        if (match) return match;
      }
      if (ts.isSourceFile(scope)) {
        for (const statement of scope.statements) {
          if (ts.isImportDeclaration(statement)) {
            const clause = statement.importClause;
            if (!clause) continue;
            if (clause.name?.text === soughtName) return clause.name;
            const bindings = clause.namedBindings;
            if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === soughtName) return bindings.name;
            if (bindings && ts.isNamedImports(bindings)) {
              const named = bindings.elements.find(element => element.name.text === soughtName);
              if (named) return named.name;
            }
          }
          if (ts.isImportEqualsDeclaration(statement) && statement.name.text === soughtName) return statement.name;
          const match = statementBinding([statement], soughtName);
          if (match) return match;
        }
      }
      return null;
    }

  function lexicalBinding(identifier) {
      if (!ts.isIdentifier(identifier)) return null;
      for (let scope = identifier.parent; scope; scope = scope.parent) {
        const binding = scopeBinding(scope, identifier.text);
        if (binding) return binding;
      }
      return null;
    }

  function moduleSpecifierForImportBinding(binding) {
      if (ts.isNamespaceImport(binding)) {
        const declaration = binding.parent.parent;
        return ts.isImportDeclaration(declaration) ? declaration.moduleSpecifier : null;
      }
      if (ts.isImportSpecifier(binding)) {
        const declaration = binding.parent.parent.parent;
        return ts.isImportDeclaration(declaration) ? declaration.moduleSpecifier : null;
      }
      return null;
    }

  function isNodeTimersModuleSpecifier(specifier) {
      return Boolean(specifier && ts.isStringLiteralLike(specifier) &&
        (specifier.text === 'node:timers' || specifier.text === 'timers'));
    }

  function isNodeTimersRequire(expression) {
      const call = unwrapParentheses(expression);
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) ||
        call.expression.text !== 'require' || lexicalBinding(call.expression) || call.arguments.length !== 1) return false;
      const specifier = unwrapParentheses(call.arguments[0]);
      return ts.isStringLiteralLike(specifier) &&
        (specifier.text === 'node:timers' || specifier.text === 'timers');
    }

  function nodeTimersNamespaceBinding(binding, seen = new Set()) {
      if (!binding || seen.has(binding)) return false;
      seen.add(binding);
      if (ts.isIdentifier(binding) && ts.isNamespaceImport(binding.parent)) binding = binding.parent;
      if (ts.isNamespaceImport(binding)) return isNodeTimersModuleSpecifier(moduleSpecifierForImportBinding(binding));
      if (!ts.isIdentifier(binding)) return false;
      if (ts.isVariableDeclaration(binding.parent) && binding.parent.initializer) {
        const initializer = unwrapParentheses(binding.parent.initializer);
        if (isNodeTimersRequire(initializer)) return true;
        if (ts.isIdentifier(initializer)) return nodeTimersNamespaceBinding(lexicalBinding(initializer), seen);
      }
      return false;
    }

  function nodeTimersFunctionBinding(binding, seen = new Set()) {
      if (!binding || seen.has(binding)) return null;
      seen.add(binding);
      if (ts.isIdentifier(binding) && ts.isImportSpecifier(binding.parent)) binding = binding.parent;
      if (ts.isImportSpecifier(binding) && isNodeTimersModuleSpecifier(moduleSpecifierForImportBinding(binding))) {
        const importedName = binding.propertyName || binding.name;
        return timerApiNames.has(importedName.text) ? importedName.text : null;
      }
      if (!ts.isIdentifier(binding)) return null;
      if (ts.isBindingElement(binding.parent)) {
        const element = binding.parent;
        const declaration = element.parent.parent;
        if (ts.isVariableDeclaration(declaration) && isNodeTimersRequire(declaration.initializer)) {
          const importedName = element.propertyName || element.name;
          return ts.isIdentifier(importedName) || ts.isStringLiteralLike(importedName)
            ? (timerApiNames.has(importedName.text) ? importedName.text : null)
            : null;
        }
      }
      if (ts.isVariableDeclaration(binding.parent) && binding.parent.initializer) {
        const initializer = unwrapParentheses(binding.parent.initializer);
        if (ts.isIdentifier(initializer)) return nodeTimersFunctionBinding(lexicalBinding(initializer), seen);
      }
      return null;
    }

  return {
    scopeDeclaresTimerName, lexicalBinding, isNodeTimersRequire,
    nodeTimersNamespaceBinding, nodeTimersFunctionBinding
  };
}

module.exports = { createOwnerBindings };
