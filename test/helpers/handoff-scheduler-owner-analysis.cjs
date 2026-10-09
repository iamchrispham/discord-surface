'use strict';

const ts = require('typescript');
const { facadeOwnerInventory } = require('./facade-owner-inventory.cjs');
const { createOwnerBindings } = require('./handoff-scheduler-owner-bindings.cjs');
const { GATEWAY_PATH, sourceFile, METHOD_HASHES, FACTORY_NAME } = require('./handoff-scheduler-owner-contracts.cjs');

const HANDOFF_STATE_FIELDS = new Set([
  'deferredHandoffRecoveryTimer',
  'deferredHandoffRecoveryTimerDeadline',
  'pendingHandoffRecoveryPollTimer',
  'deferredHandoffRecoveryChannels',
  'pendingHandoffRecoveryChannels',
  'deferredHandoffRecoveryDelayMs'
]);

function classStateInventory(sourceText) {
const source = sourceFile(GATEWAY_PATH, sourceText);
  if (source.parseDiagnostics.length) return ['source parse failed'];
  const violations = [];
  const timerOwners = [];

  function unwrapParentheses(expression) {
    while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
    return expression;
  }

  function isSchedulerFieldName(name) {
    if (!name) return false;
    if (ts.isComputedPropertyName(name)) {
      const expression = unwrapParentheses(name.expression);
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        return HANDOFF_STATE_FIELDS.has(expression.text);
      }
      return !isKnownNonSchedulerElementKey(expression);
    }
    return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && HANDOFF_STATE_FIELDS.has(name.text);
  }

  function bindingPatternHasSchedulerField(pattern) {
    return ts.isObjectBindingPattern(pattern) && pattern.elements.some(element =>
      isSchedulerFieldName(element.propertyName || element.name));
  }

  function assignmentPatternHasSchedulerField(pattern) {
    return ts.isObjectLiteralExpression(pattern) && pattern.properties.some(property => {
      if (ts.isPropertyAssignment(property)) return isSchedulerFieldName(property.name);
      return ts.isShorthandPropertyAssignment(property) && HANDOFF_STATE_FIELDS.has(property.name.text);
    });
  }

  function isKnownNonSchedulerElementKey(expression) {
    return ts.isNumericLiteral(expression) || ts.isRegularExpressionLiteral(expression) || [
      ts.SyntaxKind.BigIntLiteral,
      ts.SyntaxKind.TrueKeyword,
      ts.SyntaxKind.FalseKeyword,
      ts.SyntaxKind.NullKeyword
    ].includes(expression.kind);
  }

  const timerApiNames = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']);
  const {
    scopeDeclaresTimerName, lexicalBinding, isNodeTimersRequire,
    nodeTimersNamespaceBinding, nodeTimersFunctionBinding
  } = createOwnerBindings({ ts, source, timerApiNames, unwrapParentheses });


































  function isKnownConstructorStateInitializer(node, member) {
    if (!ts.isConstructorDeclaration(member) || !ts.isPropertyAccessExpression(node) ||
      !ts.isThis(node.expression)) return false;
    const assignment = node.parent;
    if (!ts.isBinaryExpression(assignment) || assignment.left !== node ||
      assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
    const initializer = unwrapParentheses(assignment.right);
    const initializers = {
      deferredHandoffRecoveryTimer: 'null',
      deferredHandoffRecoveryTimerDeadline: 'null',
      pendingHandoffRecoveryPollTimer: 'null',
      deferredHandoffRecoveryChannels: 'set',
      pendingHandoffRecoveryChannels: 'set',
      deferredHandoffRecoveryDelayMs: 'delay'
    };
    const expected = initializers[node.name.text];
    if (expected === 'null') return initializer.kind === ts.SyntaxKind.NullKeyword;
    if (expected === 'delay') {
      return ts.isIdentifier(initializer) &&
        initializer.text === 'DEFERRED_HANDOFF_RECOVERY_INITIAL_DELAY_MS';
    }
    return expected === 'set' && ts.isNewExpression(initializer) &&
      ts.isIdentifier(initializer.expression) && initializer.expression.text === 'Set' &&
      (!initializer.arguments || initializer.arguments.length === 0);
  }

  function receiverAliasEvents(member) {
    const events = new Map();
    const directCallsByBinding = new Map();
    let nextSequence = 0;
    function executionScope(node) {
      for (let current = node; current && current !== member; current = current.parent) {
        if (ts.isFunctionLike(current)) return current;
      }
      return member;
    }
    function scopeContains(scope, target) {
      for (let current = target; current; current = current.parent) {
        if (current === scope) return true;
        if (current === member) break;
      }
      return scope === member;
    }
    function statusAt(binding, position, targetScope) {
      const changes = binding && events.get(binding);
      if (!changes) return false;
      let status = false;
      const ordered = changes.slice().sort((left, right) =>
        left.position - right.position || left.sequence - right.sequence);
      for (const change of ordered) {
        if (change.position > position) break;
        if (scopeContains(change.scope, targetScope)) status = change.isGatewayThis;
      }
      return status;
    }
    function isConditionallyExecuted(node) {
      let current = node;
      while (current && current !== member.body && current !== member.initializer) {
        const parent = current.parent;
        if (ts.isIfStatement(parent) && current !== parent.expression) return true;
        if (ts.isConditionalExpression(parent) && current !== parent.condition) return true;
        if (ts.isBinaryExpression(parent) && current === parent.right &&
          [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) return true;
        if (ts.isIterationStatement(parent, false) && !ts.isDoStatement(parent) &&
          current === parent.statement) return true;
        if ((ts.isCaseClause(parent) || ts.isDefaultClause(parent)) &&
          parent.statements.includes(current)) return true;
        if (ts.isCatchClause(parent) && current === parent.block) return true;
        current = parent;
      }
      return false;
    }
    function receiverIsGatewayThis(expression, tracksGatewayThis) {
      expression = unwrapParentheses(expression);
      if (!expression) return false;
      if (ts.isThis(expression)) return tracksGatewayThis;
      if (ts.isIdentifier(expression)) {
        const binding = lexicalBinding(expression);
        const readScope = executionScope(expression);
        const invocations = directInvocationCalls(readScope);
        if (invocations.length) return invocations.some(invocation =>
          statusAt(binding, invocation.pos, executionScope(invocation)));
        return statusAt(binding, expression.pos, readScope);
      }
      return false;
    }
    function record(binding, position, scope, isGatewayThis, conditional, previousPosition = position - 1) {
      if (!binding) return;
      if (conditional) isGatewayThis = isGatewayThis || statusAt(binding, previousPosition, scope);
      const changes = events.get(binding) || [];
      changes.push({ position, scope, isGatewayThis, sequence: nextSequence++ });
      events.set(binding, changes);
    }
    function immediateInvocation(functionNode) {
      let expression = functionNode;
      let parent = expression.parent;
      while (parent && ts.isParenthesizedExpression(parent)) {
        expression = parent;
        parent = parent.parent;
      }
      return parent && ts.isCallExpression(parent) && parent.expression === expression ? parent : null;
    }
    function finiteArrayCallbackInvocation(functionNode) {
      let expression = functionNode;
      while (expression.parent && ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
      const invocation = expression.parent;
      if (!invocation || !ts.isCallExpression(invocation) ||
        !invocation.arguments.some(argument => unwrapParentheses(argument) === functionNode)) return null;
      const callee = unwrapParentheses(invocation.expression);
      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'forEach') return null;
      const receiver = unwrapParentheses(callee.expression);
      if (!ts.isArrayLiteralExpression(receiver) || receiver.elements.length === 0 ||
        receiver.elements.some(ts.isSpreadElement)) return null;
      return invocation;
    }
    function functionBinding(functionNode) {
      if (ts.isFunctionDeclaration(functionNode) && functionNode.name) return lexicalBinding(functionNode.name);
      let expression = functionNode;
      while (expression.parent && ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
      const declaration = expression.parent;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer === expression &&
        ts.isIdentifier(declaration.name)) return lexicalBinding(declaration.name);
      return null;
    }
    function directInvocationCalls(functionNode) {
      const binding = functionBinding(functionNode);
      return binding ? directCallsByBinding.get(binding) || [] : [];
    }
    function indexDirectInvocationCalls(node) {
      function visit(current) {
        if (ts.isCallExpression(current)) {
          const expression = unwrapParentheses(current.expression);
          if (ts.isIdentifier(expression) && executionScope(current) === member) {
            const binding = lexicalBinding(expression);
            if (binding) {
              const calls = directCallsByBinding.get(binding) || [];
              calls.push(current);
              directCallsByBinding.set(binding, calls);
            }
          }
        }
        ts.forEachChild(current, visit);
      }
      if (member.body) visit(member.body);
      if (member.initializer) visit(member.initializer);
    }
    function collect(node, tracksGatewayThis = true) {
      const startsDynamicThisScope = ts.isClassDeclaration(node) || ts.isClassExpression(node) ||
        ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
        ts.isGetAccessor(node) || ts.isSetAccessor(node);
      const tracksGatewayThisHere = tracksGatewayThis && !startsDynamicThisScope;
      const scope = executionScope(node);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = receiverIsGatewayThis(node.initializer, tracksGatewayThisHere);
        record(node.name, node.end, scope, value, isConditionallyExecuted(node));
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrapParentheses(node.left))) {
        const left = unwrapParentheses(node.left);
        const value = receiverIsGatewayThis(node.right, tracksGatewayThisHere);
        const conditional = isConditionallyExecuted(node);
        record(lexicalBinding(left), node.end, scope, value, conditional);
        if (scope !== member) {
          const invocation = immediateInvocation(scope) || finiteArrayCallbackInvocation(scope);
          if (invocation) {
            const callerScope = executionScope(invocation);
            record(lexicalBinding(left), invocation.end, callerScope, value,
              conditional || isConditionallyExecuted(invocation), invocation.end);
          }
        }
      }
      ts.forEachChild(node, child => collect(child, tracksGatewayThisHere));
    }
    indexDirectInvocationCalls(member.body || member.initializer);
    if (member.body) collect(member.body);
    if (member.initializer) collect(member.initializer);
    for (const parameter of member.parameters || []) collect(parameter);
    for (const changes of events.values()) changes.sort((left, right) =>
      left.position - right.position || left.sequence - right.sequence);
    return { receiverIsGatewayThis, statusAt };
  }
  function timerReference(expression) {
    return resolveTimerReference(expression, new Set());
  }
  function resolveTimerReference(expression, visitedBindings) {
    expression = unwrapParentheses(expression);
    if (!expression) return null;
    if (ts.isIdentifier(expression)) {
      const binding = lexicalBinding(expression);
      const importedTimerName = nodeTimersFunctionBinding(binding);
      if (importedTimerName) return importedTimerName;
      if (binding && !visitedBindings.has(binding)) {
        visitedBindings.add(binding);
        const declaration = binding.parent;
        const declarationList = declaration?.parent;
        if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer &&
          ts.isIdentifier(declaration.name) && declarationList && ts.isVariableDeclarationList(declarationList) &&
          (declarationList.flags & ts.NodeFlags.Const) !== 0) {
          const aliasedTimer = resolveTimerReference(declaration.initializer, visitedBindings);
          if (aliasedTimer) return aliasedTimer;
        }
      }
      const timerName = expression.text;
      if (!timerApiNames.has(timerName)) return null;
      for (let scope = expression.parent; scope; scope = scope.parent) {
        if (scopeDeclaresTimerName(scope, timerName)) return null;
      }
      return timerName;
    }
    if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return null;
    const receiver = unwrapParentheses(expression.expression);
    let timerName;
    if (ts.isPropertyAccessExpression(expression)) {
      timerName = expression.name.text;
    } else {
      const property = unwrapParentheses(expression.argumentExpression);
      if (!property || (!ts.isStringLiteral(property) && !ts.isNoSubstitutionTemplateLiteral(property))) return null;
      timerName = property.text;
    }
    if (!timerApiNames.has(timerName)) return null;
    if (isNodeTimersRequire(receiver)) return timerName;
    if (!ts.isIdentifier(receiver)) return null;
    if (nodeTimersNamespaceBinding(lexicalBinding(receiver))) return timerName;
    if (!['global', 'globalThis'].includes(receiver.text)) return null;
    for (let scope = expression.parent; scope; scope = scope.parent) {
      if (scopeDeclaresTimerName(scope, receiver.text)) return null;
    }
    return timerName;
  }
  function isUnshadowedTimerCall(node) {
    if (!ts.isCallExpression(node)) return false;
    const callee = unwrapParentheses(node.expression);
    if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
      const forwardingName = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : unwrapParentheses(callee.argumentExpression)?.text;
      if (["call", "apply"].includes(forwardingName)) return timerReference(callee.expression) !== null;
    }
    if (ts.isCallExpression(callee)) {
      const bindAccess = unwrapParentheses(callee.expression);
      if ((ts.isPropertyAccessExpression(bindAccess) || ts.isElementAccessExpression(bindAccess)) &&
        (ts.isPropertyAccessExpression(bindAccess) ? bindAccess.name.text :
          unwrapParentheses(bindAccess.argumentExpression)?.text) === 'bind') {
        return timerReference(bindAccess.expression) !== null;
      }
    }
    return timerReference(callee) !== null;
  }
  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name?.text === 'DiscordGateway') {
      for (const member of node.members) {

        const memberName = ts.isConstructorDeclaration(member)
          ? 'constructor'
          : member.name?.getText(source) || 'unnamed class member';
        const receiverAliases = receiverAliasEvents(member);
        let accessesSchedulerState = false;
        function scan(bodyNode, tracksGatewayThis = true) {
          const startsDynamicThisScope = ts.isClassDeclaration(bodyNode) || ts.isClassExpression(bodyNode) ||
            ts.isFunctionDeclaration(bodyNode) || ts.isFunctionExpression(bodyNode) ||
            ts.isMethodDeclaration(bodyNode) || ts.isConstructorDeclaration(bodyNode) ||
            ts.isGetAccessor(bodyNode) || ts.isSetAccessor(bodyNode);
          const tracksGatewayThisHere = tracksGatewayThis && !startsDynamicThisScope;
          if (isUnshadowedTimerCall(bodyNode) && !timerOwners.includes(memberName)) {
            timerOwners.push(memberName);
          }
          if (ts.isPropertyAccessExpression(bodyNode) &&
            receiverAliases.receiverIsGatewayThis(bodyNode.expression, tracksGatewayThisHere) &&
            HANDOFF_STATE_FIELDS.has(bodyNode.name.text) &&
            !isKnownConstructorStateInitializer(bodyNode, member)) accessesSchedulerState = true;
          if (ts.isElementAccessExpression(bodyNode) &&
            receiverAliases.receiverIsGatewayThis(bodyNode.expression, tracksGatewayThisHere)) {
            const key = unwrapParentheses(bodyNode.argumentExpression);
            if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
              if (HANDOFF_STATE_FIELDS.has(key.text)) accessesSchedulerState = true;
            } else if (!isKnownNonSchedulerElementKey(key)) {
              accessesSchedulerState = true;
            }
          }
          if (ts.isVariableDeclaration(bodyNode) &&
            bindingPatternHasSchedulerField(bodyNode.name) &&
            bodyNode.initializer && receiverAliases.receiverIsGatewayThis(bodyNode.initializer, tracksGatewayThisHere)) {
            accessesSchedulerState = true;
          }
          if (ts.isBinaryExpression(bodyNode) &&
            bodyNode.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            receiverAliases.receiverIsGatewayThis(bodyNode.right, tracksGatewayThisHere) &&
            assignmentPatternHasSchedulerField(unwrapParentheses(bodyNode.left))) accessesSchedulerState = true;
          if (ts.isCallExpression(bodyNode) && bodyNode.arguments.length > 1) {
            const callee = unwrapParentheses(bodyNode.expression);
            let objectShadowed = false;
            if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
              callee.expression.text === 'Object') {
              for (let current = callee.expression.parent; current; current = current.parent) {
                if (scopeDeclaresTimerName(current, 'Object')) {
                  objectShadowed = true;
                  break;
                }
              }
            }
            const isObjectAssign = ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression) && callee.expression.text === 'Object' &&
              callee.name.text === 'assign' && !objectShadowed;
            if (isObjectAssign && receiverAliases.receiverIsGatewayThis(bodyNode.arguments[0], tracksGatewayThisHere)) {
              for (const source of bodyNode.arguments.slice(1)) {
                if (!ts.isObjectLiteralExpression(unwrapParentheses(source))) continue;
                const properties = unwrapParentheses(source).properties;
                if (properties.some(property => {
                  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
                  let name = null;
                  if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
                    name = property.name.text;
                  } else if (ts.isComputedPropertyName(property.name)) {
                    const key = unwrapParentheses(property.name.expression);
                    if (ts.isStringLiteralLike(key)) name = key.text;
                  }
                  return HANDOFF_STATE_FIELDS.has(name);
                })) accessesSchedulerState = true;
              }
            }
          }

          ts.forEachChild(bodyNode, child => scan(child, tracksGatewayThisHere));
        }
        if (member.body) scan(member.body);
        if (member.initializer) scan(member.initializer);
        for (const parameter of member.parameters || []) {
          if (parameter.initializer && receiverAliases.receiverIsGatewayThis(parameter.initializer, true) &&
            bindingPatternHasSchedulerField(parameter.name)) {
            accessesSchedulerState = true;
          }
          scan(parameter);
        }
        if (accessesSchedulerState &&
          !['scheduleDeferredHandoffRecovery', 'schedulePendingHandoffRecoveryPoll'].includes(memberName)) {
          violations.push(memberName);
        }
        if (timerOwners.includes(memberName)) violations.push(`${memberName}: timer API`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (timerOwners.length !== 0) violations.push(`unexpected timer owners: ${timerOwners.join(',')}`);
  violations.push(...facadeOwnerInventory(ts, source, { ownerName: 'handoffSchedulerHandlers', factoryName: FACTORY_NAME, facadeNames: Object.keys(METHOD_HASHES) }));
  return violations;
}

module.exports = { classStateInventory };
