function borrowedStringInput(call, regexReference, ts) {
  if (!ts.isCallExpression(call) || call.arguments[1] !== regexReference ||
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== 'call' ||
      !ts.isPropertyAccessExpression(call.expression.expression) ||
      !['search', 'match'].includes(call.expression.expression.name.text)) {
    return null;
  }
  return call.arguments[0] || null;
}

function createPolicyRegexAnalysis({
  ts,
  infos,
  byFile,
  resolveBinding,
  resolveModule,
  resolveFunction,
  findBinding,
  bindingCalls,
  objectIsRoom,
  expressionIsRoomField,
  hasContextualParameterCall,
  borrowedStringInput,
  regexInput,
  collectBindings,
  callPropertyName,
  isAncestor,
  enclosingFunction,
  unwrapPolicyExpression,
  policyPropertyKey,
  resolveStringValue,
  hasAsciiDigitPattern,
  isTownHallContext,
  isNeutralRoomPolicy,
  isTownHallRoomOwner,
  roomFieldSubject,
  isSplitRoomDigitPolicy,
}) {
  const regexInputs = (node, info) => {
    const inputs = [];
    const direct = regexInput(node);
    if (direct) inputs.push(direct);
    const collectMatcherInputs = reference => {
      let current = reference;
      while (current.parent) {
        const parent = current.parent;
        if (ts.isCallExpression(parent)) {
          const argumentIndex = parent.arguments.findIndex(argument =>
            argument === reference || isAncestor(argument, reference));
          if (argumentIndex !== -1) {
            const matcher = resolveFunction(info, parent.expression);
            if (!matcher || matcher.info !== info) {
              current = parent;
              continue;
            }
            const parameter = matcher.node.parameters[argumentIndex];
            if (!parameter || !ts.isIdentifier(parameter.name) || !matcher.node.body) return;
            const binding = findBinding(matcher.info, parameter.name.text, parameter.name);
            if (!binding || binding.kind !== 'parameter') return;
            const visitMatcher = candidate => {
              if (ts.isIdentifier(candidate) && candidate.text === parameter.name.text &&
                  findBinding(matcher.info, candidate.text, candidate) === binding) {
                const input = regexInput(candidate);
                if (input) inputs.push(input);
              }
              ts.forEachChild(candidate, visitMatcher);
            };
            visitMatcher(matcher.node.body);
            return;
          }
        }
        current = parent;
      }
    };
    collectMatcherInputs(node);
    const factoryScope = enclosingFunction(node);
    const factory = info.functionDefs.find(candidate => candidate.node === factoryScope);
    let returnedByFactory = false;
    if (factoryScope?.body) {
      const findReturnedPattern = candidate => {
        if (ts.isReturnStatement(candidate) && candidate.expression &&
            isAncestor(candidate.expression, node)) {
          returnedByFactory = true;
        }
        ts.forEachChild(candidate, findReturnedPattern);
      };
      findReturnedPattern(factoryScope.body);
      returnedByFactory ||= ts.isArrowFunction(factoryScope) &&
        isAncestor(factoryScope.body, node);
    }
    if (factory && returnedByFactory) {
      for (const call of factory.calls) {
        const callNode = call.node;
        const matcher = callNode.parent;
        if ((ts.isPropertyAccessExpression(matcher) || ts.isElementAccessExpression(matcher)) &&
            matcher.expression === callNode && ['test', 'exec'].includes(callPropertyName(matcher)) &&
            ts.isCallExpression(matcher.parent) && matcher.parent.arguments[0]) {
          inputs.push(matcher.parent.arguments[0]);
        }
      }
    }
    let propertyAssignment = node.parent;
    while (propertyAssignment &&
        (ts.isParenthesizedExpression(propertyAssignment) || ts.isAsExpression(propertyAssignment) ||
          ts.isTypeAssertionExpression(propertyAssignment) || ts.isNonNullExpression(propertyAssignment) ||
          (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(propertyAssignment)))) {
      propertyAssignment = propertyAssignment.parent;
    }
    propertyAssignment = propertyAssignment && ts.isPropertyAssignment(propertyAssignment) &&
      isAncestor(propertyAssignment.initializer, node) ? propertyAssignment : null;
    const objectLiteral = propertyAssignment?.parent && ts.isObjectLiteralExpression(propertyAssignment.parent)
      ? propertyAssignment.parent
      : null;
    const objectDeclaration = objectLiteral?.parent && ts.isVariableDeclaration(objectLiteral.parent) &&
      objectLiteral.parent.initializer === objectLiteral && ts.isIdentifier(objectLiteral.parent.name)
      ? objectLiteral.parent
      : null;
    if (propertyAssignment && objectDeclaration &&
        (ts.isIdentifier(propertyAssignment.name) || ts.isStringLiteralLike(propertyAssignment.name))) {
      const ownerName = objectDeclaration.name.text;
      const propertyName = propertyAssignment.name.text;
      const visitObject = current => {
        if (ts.isIdentifier(current) && current.text === ownerName && current !== objectDeclaration.name &&
            findBinding(info, ownerName, current)?.declaration === objectDeclaration) {
          const member = current.parent;
          if ((ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
              member.expression === current && policyPropertyKey(member) === propertyName) {
            const input = regexInput(member);
            if (input) inputs.push(input);
          }
        }
        ts.forEachChild(current, visitObject);
      };
      visitObject(info.ast);
    }
    let classProperty = node.parent;
    while (classProperty &&
        (ts.isParenthesizedExpression(classProperty) || ts.isAsExpression(classProperty) ||
          ts.isTypeAssertionExpression(classProperty) || ts.isNonNullExpression(classProperty) ||
          (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(classProperty)))) {
      classProperty = classProperty.parent;
    }
    classProperty = classProperty && ts.isPropertyDeclaration(classProperty) &&
      isAncestor(classProperty.initializer, node) ? classProperty : null;
    const classDeclaration = classProperty?.parent && ts.isClassDeclaration(classProperty.parent)
      ? classProperty.parent
      : null;
    if (classProperty && classDeclaration?.name && ts.isIdentifier(classDeclaration.name) &&
        classProperty.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
        (ts.isIdentifier(classProperty.name) || ts.isStringLiteralLike(classProperty.name))) {
      const ownerName = classDeclaration.name.text;
      const propertyName = classProperty.name.text;
      const classBindings = collectBindings(info.ast);
      const visitClass = current => {
        if (ts.isIdentifier(current) && current.text === ownerName && current !== classDeclaration.name &&
            resolveBinding(current, classBindings) === classDeclaration) {
          const member = current.parent;
          if ((ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
              member.expression === current && policyPropertyKey(member) === propertyName) {
            const input = regexInput(member);
            if (input) inputs.push(input);
          }
        }
        ts.forEachChild(current, visitClass);
      };
      visitClass(info.ast);
    }
    let declaration = node.parent;
    while (declaration && !ts.isVariableDeclaration(declaration) && declaration.parent) {
      declaration = declaration.parent;
    }
    declaration = declaration && ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) && isAncestor(declaration.initializer, node) ? declaration : null;
    if (!declaration) return inputs;
    const seenDeclarations = new Set();
    const collectDeclarationInputs = currentDeclaration => {
      if (seenDeclarations.has(currentDeclaration)) return;
      seenDeclarations.add(currentDeclaration);
      const name = currentDeclaration.name.text;
      const visit = current => {
        if (ts.isIdentifier(current) && current.text === name && current !== currentDeclaration.name &&
            findBinding(info, name, current)?.declaration === currentDeclaration) {
          collectMatcherInputs(current);
          const parent = current.parent;
          if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
              parent.expression === current &&
              ['test', 'exec'].includes(callPropertyName(parent)) && ts.isCallExpression(parent.parent)) {
            if (parent.parent.arguments[0]) inputs.push(parent.parent.arguments[0]);
          } else if (ts.isCallExpression(parent) && parent.arguments[0] === current &&
              ['match', 'search'].includes(callPropertyName(parent.expression))) {
            inputs.push(parent.expression.expression);
          } else if (ts.isCallExpression(parent) &&
              borrowedStringInput(parent, current, ts)) {
            inputs.push(borrowedStringInput(parent, current, ts));
          } else if (ts.isVariableDeclaration(parent) && parent.initializer === current &&
              ts.isIdentifier(parent.name) &&
              findBinding(info, parent.name.text, parent.name)?.declaration === parent) {
            collectDeclarationInputs(parent);
          }
        }
        ts.forEachChild(current, visit);
      };
      visit(info.ast);
    };
    collectDeclarationInputs(declaration);
    return inputs;
  };

  const importedRegexInputs = (info, localName, imported) => {
    const inputs = [];
    const seenDeclarations = new Set();
    function collectReferenceInputs(reference) {
      const parent = reference.parent;
      if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === reference &&
          ['test', 'exec'].includes(callPropertyName(parent)) && ts.isCallExpression(parent.parent)) {
        if (parent.parent.arguments[0]) inputs.push(parent.parent.arguments[0]);
      } else if (ts.isCallExpression(parent) && parent.arguments[0] === reference &&
          ['match', 'search'].includes(callPropertyName(parent.expression))) {
        inputs.push(parent.expression.expression);
      } else if (ts.isCallExpression(parent) &&
          borrowedStringInput(parent, reference, ts)) {
        inputs.push(borrowedStringInput(parent, reference, ts));
      } else if (ts.isVariableDeclaration(parent) && parent.initializer === reference &&
          ts.isIdentifier(parent.name) &&
          findBinding(info, parent.name.text, parent)?.declaration === parent) {
        collectDeclarationInputs(parent);
      }
    }
    function collectDeclarationInputs(declaration) {
      if (seenDeclarations.has(declaration)) return;
      seenDeclarations.add(declaration);
      const name = declaration.name.text;
      const visitDeclaration = node => {
        if (ts.isIdentifier(node) && node.text === name && node !== declaration.name &&
            findBinding(info, name, node)?.declaration === declaration) {
          collectReferenceInputs(node);
        }
        ts.forEachChild(node, visitDeclaration);
      };
      visitDeclaration(info.ast);
    }
    const visit = node => {
      if (ts.isIdentifier(node) && node.text === localName) {
        const binding = findBinding(info, localName, node);
        const importedBinding = binding &&
          (binding.kind === 'import' || binding.kind === 'commonjs-import') &&
          binding.imported === imported.imported && binding.specifier === imported.specifier;
        if (importedBinding) {
          collectReferenceInputs(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
    return inputs;
  };

  const namespaceRegexInputs = (info, namespaceName) => {
    const inputs = [];
    const visit = node => {
      if (ts.isIdentifier(node) && node.text === namespaceName) {
        const binding = findBinding(info, namespaceName, node);
        const isDefaultImport = binding?.kind === 'import' && binding.imported === 'default';
        const isCommonJsNamespace = binding?.kind === 'commonjs-import' &&
          binding.imported === 'default';
        if (!binding || (binding.kind !== 'namespace-import' && !isDefaultImport && !isCommonJsNamespace)) {
          ts.forEachChild(node, visit);
          return;
        }
        const member = node.parent;
        if ((ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
            member.expression === node) {
          const importedName = policyPropertyKey(member);
          const input = importedName && regexInput(member);
          if (input) inputs.push({ importedName, input });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
    return inputs;
  };

  const resolveRegexValue = (info, expression, name, seen = new Set()) => {
    const value = unwrapPolicyExpression(expression);
    if (!value) return null;
    if (ts.isRegularExpressionLiteral(value)) {
      let declaration = value.parent;
      while (declaration && !ts.isVariableDeclaration(declaration) && declaration.parent) {
        declaration = declaration.parent;
      }
      return { info, name, declaration: declaration || value, pattern: value.text };
    }
    if ((ts.isNewExpression(value) || ts.isCallExpression(value)) &&
        ts.isIdentifier(value.expression) && value.expression.text === 'RegExp' &&
        value.arguments?.length && ts.isStringLiteralLike(value.arguments[0])) {
      let declaration = value.parent;
      while (declaration && !ts.isVariableDeclaration(declaration) && declaration.parent) {
        declaration = declaration.parent;
      }
      return { info, name, declaration: declaration || value, pattern: value.arguments[0].text };
    }
    if (ts.isIdentifier(value)) {
      const binding = findBinding(info, value.text, value);
      if (binding?.declaration && ts.isVariableDeclaration(binding.declaration) &&
          binding.declaration.initializer && !seen.has(binding.declaration)) {
        seen.add(binding.declaration);
        return resolveRegexValue(info, binding.declaration.initializer, name, seen);
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const property = policyPropertyKey(value);
      const owner = value.expression;
      if (!property || !ts.isIdentifier(owner)) return null;
      const ownerBinding = findBinding(info, owner.text, owner);
      const initializer = ownerBinding?.declaration?.initializer;
      const object = unwrapPolicyExpression(initializer);
      if (!object || !ts.isObjectLiteralExpression(object)) return null;
      const propertyNode = object.properties.find(candidate => {
        if (!ts.isPropertyAssignment(candidate) && !ts.isMethodDeclaration(candidate)) return false;
        const key = candidate.name;
        return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && key.text === property;
      });
      if (!propertyNode || !ts.isPropertyAssignment(propertyNode)) return null;
      return resolveRegexValue(info, propertyNode.initializer, name, seen);
    }
    return null;
  };

  const resolveRegexExport = (info, name, seen = new Set()) => {
    const marker = `${info.file}\u0000${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const exported = info.exports.get(name);
    if (exported && typeof exported === 'object') {
      if (exported.kind === 'reexport') {
        const target = resolveModule(info, exported.specifier);
        return target ? resolveRegexExport(target, exported.imported, seen) : null;
      }
      if (exported.kind === 'regex') return { ...exported, info, name };
      return null;
    }
    for (const specifier of info.starExports) {
      const target = resolveModule(info, specifier);
      const resolved = target ? resolveRegexExport(target, name, seen) : null;
      if (resolved) return resolved;
    }
    const localName = typeof exported === 'string' ? exported : name;
    const binding = findBinding(info, localName, info.ast);
    if (binding?.declaration && ts.isVariableDeclaration(binding.declaration) &&
        binding.declaration.initializer) {
      return resolveRegexValue(info, binding.declaration.initializer, name);
    }
    let result = null;
    const visit = node => {
      if (result || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) ||
          node.name.text !== localName || !node.initializer) {
        ts.forEachChild(node, visit);
        return;
      }
      result = resolveRegexValue(info, node.initializer, name);
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
    return result;
  };

  function resolveStringExport(info, name, seen = new Set()) {
    const marker = `${info.file}\u0000${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const exported = info.exports.get(name);
    if (exported && typeof exported === 'object') {
      if (exported.kind === 'reexport') {
        const target = resolveModule(info, exported.specifier);
        return target ? resolveStringExport(target, exported.imported, seen) : null;
      }
      return null;
    }
    const localName = typeof exported === 'string' ? exported : name;
    let declaration = findBinding(info, localName, info.ast)?.declaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      declaration = null;
      const visit = node => {
        if (declaration || !ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) ||
            node.name.text !== localName || !node.initializer) {
          ts.forEachChild(node, visit);
          return;
        }
        declaration = node;
      };
      visit(info.ast);
    }
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return null;
    return resolveStringValue(declaration.initializer, collectBindings(info.ast), seen,
      (identifier, nestedSeen) => resolveImportedString(info, identifier, nestedSeen));
  }

  function resolveImportedString(info, identifier, seen) {
    const imported = info.imports.get(identifier.text);
    if (!imported || imported.namespace || !imported.specifier || !imported.imported) return null;
    const target = resolveModule(info, imported.specifier);
    return target ? resolveStringExport(target, imported.imported, seen) : null;
  }

  return {
    regexInputs,
    importedRegexInputs,
    namespaceRegexInputs,
    resolveRegexExport,
    resolveImportedString,
  };
}

module.exports = { borrowedStringInput, createPolicyRegexAnalysis };
