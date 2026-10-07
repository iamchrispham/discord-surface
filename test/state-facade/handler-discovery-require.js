const ts = require('typescript');

const { declarationScope, isScopeNode, propertyName, scopeNode } = require('./handler-discovery-lexical');

function requireBindings(source) {
  const bindings = [];
  const addBinding = (name, declaration, modulePath, exportName) => {
    bindings.push({ name, declaration, scope: declarationScope(declaration), modulePath, exportName, reassigned: false });
  };
  const visit = node => {
    if (node !== source && ts.isFunctionLike(node)) return;
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!declaration.initializer || !ts.isCallExpression(declaration.initializer) ||
            !ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== 'require' ||
            declaration.initializer.arguments.length !== 1 || !ts.isStringLiteral(declaration.initializer.arguments[0])) continue;
        const modulePath = declaration.initializer.arguments[0].text;
        if (ts.isIdentifier(declaration.name)) {
          addBinding(declaration.name.text, declaration, modulePath, null);
          continue;
        }
        if (!ts.isObjectBindingPattern(declaration.name)) continue;
        for (const element of declaration.name.elements) {
          if (!ts.isBindingElement(element)) continue;
          const imported = propertyName(element.propertyName || element.name);
          const local = ts.isIdentifier(element.name) ? element.name.text : null;
          if (imported && local) addBinding(local, element.name, modulePath, imported);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const scopeChain = identifier => {
    const scopes = [];
    let current = scopeNode(identifier);
    while (current) {
      scopes.push(current);
      current = current.parent;
      while (current && !isScopeNode(current)) current = current.parent;
    }
    return scopes;
  };
  const resolve = (name, identifier) => {
    if (!identifier || !ts.isIdentifier(identifier)) return null;
    const useStart = identifier.getStart(source);
    for (const scope of scopeChain(identifier)) {
      const candidates = bindings.filter(binding => binding.name === name && binding.scope === scope &&
        binding.declaration.getStart(source) <= useStart);
      if (candidates.length) return candidates[candidates.length - 1];
    }
    return null;
  };
  const isAssignmentOperator = kind => kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  const markReassignments = node => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) && ts.isIdentifier(node.left)) {
      const binding = resolve(node.left.text, node.left);
      if (binding) binding.reassigned = true;
    }
    ts.forEachChild(node, markReassignments);
  };
  markReassignments(source);
  return {
    get(name, identifier = null) {
      if (identifier) {
        const binding = resolve(name, identifier);
        return binding && !binding.reassigned ? binding : null;
      }
      const topLevel = bindings.filter(binding => binding.name === name && binding.scope === source && !binding.reassigned);
      const anyScope = bindings.filter(binding => binding.name === name && !binding.reassigned);
      return (topLevel.length ? topLevel : anyScope).at(-1) || null;
    }
  };
}

module.exports = { requireBindings };
