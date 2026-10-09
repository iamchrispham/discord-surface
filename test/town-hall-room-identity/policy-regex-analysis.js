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
    const defaultParameter = node.parent;
    if (defaultParameter && ts.isParameter(defaultParameter) && defaultParameter.initializer &&
        isAncestor(defaultParameter.initializer, node) && ts.isIdentifier(defaultParameter.name)) {
      const matcher = info.functionDefs.find(candidate => candidate.node === defaultParameter.parent);
      const patternBinding = findBinding(info, defaultParameter.name.text, defaultParameter.name);
      if (matcher?.node.body && patternBinding) {
        const patternIndex = matcher.node.parameters.indexOf(defaultParameter);
        const inputParameterIndexes = new Set();
        const directInputs = [];
        const visitMatcher = candidate => {
          if (ts.isIdentifier(candidate) && candidate.text === defaultParameter.name.text &&
              findBinding(info, candidate.text, candidate) === patternBinding) {
            const input = regexInput(candidate);
            if (input) {
              const inputBinding = ts.isIdentifier(input)
                ? findBinding(info, input.text, input)
                : null;
              const inputIndex = matcher.node.parameters.findIndex(parameter =>
                ts.isIdentifier(parameter.name) && inputBinding &&
                findBinding(info, parameter.name.text, parameter.name) === inputBinding);
              if (inputIndex >= 0) inputParameterIndexes.add(inputIndex);
              else directInputs.push(input);
            }
          }
          ts.forEachChild(candidate, visitMatcher);
        };
        visitMatcher(matcher.node.body);
        const visitCalls = candidate => {
          if (ts.isCallExpression(candidate) &&
              !candidate.arguments.some(argument => ts.isSpreadElement(argument))) {
            const resolved = resolveFunction(info, candidate.expression);
            const defaultArgument = candidate.arguments[patternIndex];
            const usesDefault = candidate.arguments.length <= patternIndex ||
              (ts.isIdentifier(defaultArgument) && defaultArgument.text === 'undefined' &&
                !findBinding(info, 'undefined', defaultArgument));
            if (resolved?.info === info && resolved.node === matcher.node &&
                usesDefault) {
              for (const inputIndex of inputParameterIndexes) {
                if (candidate.arguments[inputIndex]) inputs.push(candidate.arguments[inputIndex]);
              }
              inputs.push(...directInputs);
            }
          }
          ts.forEachChild(candidate, visitCalls);
        };
        visitCalls(info.ast);
        for (const call of matcher.calls) {
          const candidate = call.node;
          if (candidate.getSourceFile() === info.ast || !ts.isCallExpression(candidate) ||
              candidate.arguments.some(argument => ts.isSpreadElement(argument))) continue;
          const callInfo = infos.find(candidateInfo => candidateInfo.ast === candidate.getSourceFile()) || info;
          const defaultArgument = candidate.arguments[patternIndex];
          const usesDefault = candidate.arguments.length <= patternIndex ||
            (ts.isIdentifier(defaultArgument) && defaultArgument.text === 'undefined' &&
              !findBinding(callInfo, 'undefined', defaultArgument));
          if (!usesDefault) continue;
          for (const inputIndex of inputParameterIndexes) {
            if (candidate.arguments[inputIndex]) inputs.push(candidate.arguments[inputIndex]);
          }
          inputs.push(...directInputs);
        }
      }
    }
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
        const declaration = callNode.parent;
        if (ts.isVariableDeclaration(declaration) && declaration.initializer === callNode &&
            ts.isIdentifier(declaration.name)) {
          const storedBinding = findBinding(info, declaration.name.text, declaration.name);
          const matcherScope = enclosingFunction(callNode);
          if (storedBinding && matcherScope?.body) {
            const findStoredMatcherInputs = candidate => {
              if ((ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) &&
                  ts.isIdentifier(candidate.expression) &&
                  findBinding(info, candidate.expression.text, candidate.expression) === storedBinding &&
                  ['test', 'exec'].includes(callPropertyName(candidate)) &&
                  ts.isCallExpression(candidate.parent) && candidate.parent.arguments[0]) {
                inputs.push(candidate.parent.arguments[0]);
              }
              ts.forEachChild(candidate, findStoredMatcherInputs);
            };
            findStoredMatcherInputs(matcherScope.body);
          }
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
    const classValueExpression = member => {
      if (ts.isPropertyDeclaration(member)) return member.initializer;
      if (!ts.isGetAccessorDeclaration(member) || !member.body ||
          member.body.statements.length !== 1) return null;
      const statement = member.body.statements[0];
      return ts.isReturnStatement(statement) ? statement.expression : null;
    };
    let classProperty = node.parent;
    while (classProperty &&
        (ts.isParenthesizedExpression(classProperty) || ts.isAsExpression(classProperty) ||
          ts.isTypeAssertionExpression(classProperty) || ts.isNonNullExpression(classProperty) ||
          (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(classProperty)))) {
      classProperty = classProperty.parent;
    }
    if (classProperty && ts.isReturnStatement(classProperty)) {
      const body = classProperty.parent;
      const accessor = body && ts.isBlock(body) ? body.parent : null;
      const value = accessor && ts.isGetAccessorDeclaration(accessor)
        ? classValueExpression(accessor)
        : null;
      classProperty = value && isAncestor(value, node) ? accessor : null;
    }
    const classValue = classProperty ? classValueExpression(classProperty) : null;
    classProperty = classValue && isAncestor(classValue, node) ? classProperty : null;
    const classDeclaration = classProperty?.parent && ts.isClassDeclaration(classProperty.parent)
      ? classProperty.parent
      : null;
    if (classProperty && classDeclaration?.name && ts.isIdentifier(classDeclaration.name) &&
        (ts.isIdentifier(classProperty.name) || ts.isStringLiteralLike(classProperty.name))) {
      const propertyName = classProperty.name.text;
      const classBindings = collectBindings(info.ast);
      const isConstructor = expression => {
        const value = unwrapPolicyExpression(expression);
        return ts.isNewExpression(value) && ts.isIdentifier(value.expression) &&
          resolveBinding(value.expression, classBindings) === classDeclaration;
      };
      const isLocalInstance = expression => {
        const value = unwrapPolicyExpression(expression);
        if (!ts.isIdentifier(value)) return false;
        const declaration = resolveBinding(value, classBindings);
        if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
          return false;
        }
        const declarationList = declaration.parent;
        return ts.isVariableDeclarationList(declarationList) &&
          Boolean(declarationList.flags & ts.NodeFlags.Const) &&
          isConstructor(declaration.initializer);
      };
      const isStaticClass = expression => {
        const value = unwrapPolicyExpression(expression);
        return ts.isIdentifier(value) &&
          resolveBinding(value, classBindings) === classDeclaration;
      };
      const isStatic = classProperty.modifiers?.some(
        modifier => modifier.kind === ts.SyntaxKind.StaticKeyword,
      );
      const visitClass = current => {
        if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
          const receiver = current.expression;
          const receiverMatches = isStatic
            ? isStaticClass(receiver)
            : isConstructor(receiver) || isLocalInstance(receiver);
          if (policyPropertyKey(current) === propertyName && receiverMatches) {
            const input = regexInput(current);
            if (input) inputs.push(input);
          }
        }
        ts.forEachChild(current, visitClass);
      };
      visitClass(info.ast);
    }
    let assignedPropertyName = null;
    let declaration = node.parent;
    while (declaration && !ts.isVariableDeclaration(declaration) && declaration.parent) {
      declaration = declaration.parent;
    }
    declaration = declaration && ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) && isAncestor(declaration.initializer, node) ? declaration : null;
    if (!declaration) {
      let assignment = node.parent;
      while (assignment && !ts.isBinaryExpression(assignment) && assignment.parent) {
        assignment = assignment.parent;
      }
      const memberTarget = assignment && ts.isBinaryExpression(assignment) &&
        (ts.isPropertyAccessExpression(assignment.left) || ts.isElementAccessExpression(assignment.left));
      let targetIdentifier = null;
      if (assignment && ts.isBinaryExpression(assignment)) {
        if (ts.isIdentifier(assignment.left)) targetIdentifier = assignment.left;
        else if (memberTarget && ts.isIdentifier(assignment.left.expression)) {
          targetIdentifier = assignment.left.expression;
        }
      }
      if (assignment && ts.isBinaryExpression(assignment) &&
          assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          isAncestor(assignment.right, node) && targetIdentifier) {
        const binding = findBinding(info, targetIdentifier.text, targetIdentifier);
        declaration = binding?.declaration && ts.isVariableDeclaration(binding.declaration) &&
          ts.isIdentifier(binding.declaration.name) ? binding.declaration : null;
        if (memberTarget) assignedPropertyName = policyPropertyKey(assignment.left);
      }
    }
    if (!declaration) return inputs;
    const seenDeclarations = new Set();
    const collectBoundMatcherInputs = binding => {
      const matcherBindings = collectBindings(info.ast);
      const visitMatcherCalls = current => {
        if (ts.isIdentifier(current) &&
            resolveBinding(current, matcherBindings) === binding.declaration &&
            ts.isCallExpression(current.parent) && current.parent.expression === current &&
            current.parent.arguments[0]) {
          inputs.push(current.parent.arguments[0]);
        }
        ts.forEachChild(current, visitMatcherCalls);
      };
      visitMatcherCalls(info.ast);
    };
    const collectBindingInputs = binding => {
      const bindingDeclaration = binding?.declaration;
      if (!bindingDeclaration || seenDeclarations.has(bindingDeclaration)) return;
      seenDeclarations.add(bindingDeclaration);
      const name = binding.name;
      const collectReferenceInputs = reference => {
        collectMatcherInputs(reference);
        const parent = reference.parent;
        if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
            parent.expression === reference &&
            ['test', 'exec'].includes(callPropertyName(parent)) && ts.isCallExpression(parent.parent)) {
          if (parent.parent.arguments[0]) inputs.push(parent.parent.arguments[0]);
        } else if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
            parent.expression === reference && ['test', 'exec'].includes(policyPropertyKey(parent)) &&
            ts.isPropertyAccessExpression(parent.parent) && parent.parent.expression === parent &&
            policyPropertyKey(parent.parent) === 'bind' && ts.isCallExpression(parent.parent.parent)) {
          const boundMatcherCall = parent.parent.parent;
          const matcherDeclaration = boundMatcherCall.parent;
          if (ts.isVariableDeclaration(matcherDeclaration) &&
              matcherDeclaration.initializer === boundMatcherCall &&
              ts.isIdentifier(matcherDeclaration.name)) {
            const matcherBinding = findBinding(info, matcherDeclaration.name.text, matcherDeclaration.name);
            if (matcherBinding) collectBoundMatcherInputs(matcherBinding);
          }
        } else if (assignedPropertyName &&
            (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
            parent.expression === reference && policyPropertyKey(parent) === assignedPropertyName &&
            (ts.isPropertyAccessExpression(parent.parent) || ts.isElementAccessExpression(parent.parent)) &&
            parent.parent.expression === parent &&
            ['test', 'exec'].includes(policyPropertyKey(parent.parent)) &&
            ts.isCallExpression(parent.parent.parent) && parent.parent.parent.arguments[0]) {
          inputs.push(parent.parent.parent.arguments[0]);
        } else if (ts.isCallExpression(parent) && parent.arguments[0] === reference &&
            ['match', 'search'].includes(callPropertyName(parent.expression))) {
          inputs.push(parent.expression.expression);
        } else if (ts.isCallExpression(parent) &&
            borrowedStringInput(parent, reference, ts)) {
          inputs.push(borrowedStringInput(parent, reference, ts));
        } else if (ts.isVariableDeclaration(parent) && parent.initializer === reference) {
          if (ts.isIdentifier(parent.name)) {
            collectBindingInputs(findBinding(info, parent.name.text, parent.name));
          } else if (ts.isObjectBindingPattern(parent.name)) {
            const sourceBinding = findBinding(info, reference.text, reference);
            const sourceDeclaration = sourceBinding?.declaration;
            const object = sourceDeclaration?.initializer &&
              unwrapPolicyExpression(sourceDeclaration.initializer);
            if (object && ts.isObjectLiteralExpression(object)) {
              for (const element of parent.name.elements) {
                if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
                const propertyNameNode = element.propertyName || element.name;
                if (!ts.isIdentifier(propertyNameNode) && !ts.isStringLiteralLike(propertyNameNode)) continue;
                const property = object.properties.find(candidate =>
                  ts.isPropertyAssignment(candidate) &&
                  (ts.isIdentifier(candidate.name) || ts.isStringLiteralLike(candidate.name)) &&
                  candidate.name.text === propertyNameNode.text);
                if (!property || !isAncestor(property.initializer, node)) continue;
                collectBindingInputs(findBinding(info, element.name.text, element.name));
              }
            }
          }
        }
      };
      const visit = current => {
        if (ts.isIdentifier(current) && current.text === name &&
            current !== bindingDeclaration.name &&
            findBinding(info, name, current)?.declaration === bindingDeclaration) {
          collectReferenceInputs(current);
        }
        ts.forEachChild(current, visit);
      };
      visit(info.ast);
    };
    collectBindingInputs(findBinding(info, declaration.name.text, declaration.name));
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
    const aliases = [];
    const isNamedNamespace = binding => binding?.kind === 'import' &&
      Boolean(resolveNamespaceExport(resolveModule(info, binding.specifier), binding.imported));
    const visitAliases = node => {
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) &&
          node.initializer && ts.isIdentifier(node.initializer) &&
          node.initializer.text === namespaceName) {
        const binding = findBinding(info, namespaceName, node.initializer);
        const isDefaultImport = binding?.kind === 'import' && binding.imported === 'default';
        const isCommonJsNamespace = binding?.kind === 'commonjs-import' &&
          binding.imported === 'default';
        if (binding && (binding.kind === 'namespace-import' || isDefaultImport ||
            isCommonJsNamespace || isNamedNamespace(binding))) {
          for (const element of node.name.elements) {
            if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue;
            const property = element.propertyName || element.name;
            if (!ts.isIdentifier(property) && !ts.isStringLiteralLike(property)) continue;
            const alias = findBinding(info, element.name.text, element.name);
            if (alias) {
              aliases.push({ binding: alias, name: element.name.text, importedName: property.text });
            }
          }
        }
      }
      ts.forEachChild(node, visitAliases);
    };
    visitAliases(info.ast);
    const visit = node => {
      if (ts.isIdentifier(node) && node.text === namespaceName) {
        const binding = findBinding(info, namespaceName, node);
        const isDefaultImport = binding?.kind === 'import' && binding.imported === 'default';
        const isCommonJsNamespace = binding?.kind === 'commonjs-import' &&
          binding.imported === 'default';
        if (!binding || (binding.kind !== 'namespace-import' && !isDefaultImport &&
            !isCommonJsNamespace && !isNamedNamespace(binding))) {
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
      if (ts.isIdentifier(node)) {
        const alias = aliases.find(candidate => candidate.name === node.text &&
          findBinding(info, candidate.name, node) === candidate.binding);
        const member = node.parent;
        if (alias && (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
            member.expression === node) {
          const input = regexInput(node);
          if (input) inputs.push({ importedName: alias.importedName, input });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
    return inputs;
  };

  const directDynamicImportRegexInputs = info => {
    const inputs = [];
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ['test', 'exec'].includes(node.expression.name.text) && node.arguments[0]) {
        const regexMember = node.expression.expression;
        if (ts.isPropertyAccessExpression(regexMember) || ts.isElementAccessExpression(regexMember)) {
          const importNamespace = unwrapPolicyExpression(regexMember.expression);
          const importCall = ts.isAwaitExpression(importNamespace)
            ? unwrapPolicyExpression(importNamespace.expression)
            : importNamespace;
          const importedName = policyPropertyKey(regexMember);
          if (importedName && ts.isCallExpression(importCall) &&
              importCall.expression.kind === ts.SyntaxKind.ImportKeyword &&
              importCall.arguments.length === 1 &&
              ts.isStringLiteralLike(importCall.arguments[0])) {
            inputs.push({
              specifier: importCall.arguments[0].text,
              importedName,
              input: node.arguments[0],
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
    return inputs;
  };

  const policyDefinition = (node, info, pattern) => {
    if (ts.isRegularExpressionLiteral(node)) {
      const closingSlash = node.text.lastIndexOf('/');
      return {
        kind: 'literal',
        pattern: node.text.slice(1, closingSlash),
        flags: node.text.slice(closingSlash + 1),
      };
    }
    const flagsNode = node.arguments[1];
    const flags = flagsNode
      ? resolveStringValue(
        flagsNode,
        collectBindings(info.ast),
        new Set(),
        (identifier, visited) => resolveImportedString(info, identifier, visited),
      )
      : '';
    return {
      kind: 'constructor',
      pattern,
      flags: flags === null ? `source:${flagsNode.getText()}` : flags,
    };
  };

  const resolveRegexValue = (info, expression, name, seen = new Set()) => {
    const value = unwrapPolicyExpression(expression);
    if (!value) return null;
    if (ts.isRegularExpressionLiteral(value)) {
      let declaration = value.parent;
      while (declaration && !ts.isVariableDeclaration(declaration) && declaration.parent) {
        declaration = declaration.parent;
      }
      return {
        info,
        name,
        declaration: declaration || value,
        pattern: value.text,
        definition: policyDefinition(value, info, value.text),
      };
    }
    if ((ts.isNewExpression(value) || ts.isCallExpression(value)) &&
        ts.isIdentifier(value.expression) && value.expression.text === 'RegExp' &&
        value.arguments?.length) {
      const pattern = resolveStringValue(value.arguments[0], collectBindings(info.ast), new Set(),
        (identifier, visited) => resolveImportedString(info, identifier, visited));
      if (typeof pattern !== 'string') return null;
      let declaration = value.parent;
      while (declaration && !ts.isVariableDeclaration(declaration) && declaration.parent) {
        declaration = declaration.parent;
      }
      return {
        info,
        name,
        declaration: declaration || value,
        pattern,
        definition: policyDefinition(value, info, pattern),
      };
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
    if (binding?.kind === 'import' && binding.specifier && binding.imported) {
      const target = resolveModule(info, binding.specifier);
      return target ? resolveRegexExport(target, binding.imported, seen) : null;
    }
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

  const resolveNamespaceExport = (info, name, seen = new Set()) => {
    if (!info) return null;
    const marker = `${info.file}\u0000${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const exported = info.exports.get(name);
    if (!exported || typeof exported !== 'object') return null;
    if (exported.kind === 'namespace') return resolveModule(info, exported.specifier);
    if (exported.kind !== 'reexport') return null;
    const target = resolveModule(info, exported.specifier);
    return target ? resolveNamespaceExport(target, exported.imported, seen) : null;
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
    directDynamicImportRegexInputs,
    resolveRegexExport,
    resolveNamespaceExport,
    resolveImportedString,
  };
}

module.exports = { borrowedStringInput, createPolicyRegexAnalysis };
