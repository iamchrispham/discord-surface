const crypto = require('node:crypto');

const assert = require('node:assert/strict');

const ts = require('typescript');

const { INVOCATION_STYLES, discoverFactory } = require('./handler-discovery');

function tokens(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const result = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) result.push([scanner.getTokenText(), scanner.hasPrecedingLineBreak()]);
  return result;
}

function inventory(text) {
  const source = ts.createSourceFile('state.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(source.parseDiagnostics.length, 0);
  const owner = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SurfaceState');
  assert.ok(owner);
  const handlers = new Set();
  const handlerFactories = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text.endsWith('Handlers') &&
          declaration.initializer && ts.isCallExpression(declaration.initializer) &&
          ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text.startsWith('create')) {
        handlers.add(declaration.name.text);
        handlerFactories.set(declaration.name.text, declaration.initializer.expression.text);
      }
    }
  }
  const handlerDiscoveries = [...handlerFactories].map(([name, factory]) => [name, discoverFactory(source, factory)]);
  const handlerMethodDescriptors = Object.fromEntries(handlerDiscoveries.map(([name, discovery]) => [name, discovery.methods]));
  const unapprovedHandlers = handlerDiscoveries.filter(([, discovery]) => !discovery.approved).map(([name]) => name);
  for (const name of unapprovedHandlers) handlers.delete(name);
  const callableMethods = methods => [...(methods || [])].filter(([, descriptor]) => descriptor);
  const handlerMethods = Object.fromEntries(Object.entries(handlerMethodDescriptors).map(([name, methods]) => [name,
    callableMethods(methods).map(([method]) => method).sort()]));
  const handlerContracts = Object.fromEntries(Object.entries(handlerMethodDescriptors).map(([name, methods]) => [name,
    Object.fromEntries(callableMethods(methods).map(([method, descriptor]) => [method, descriptor.style]))]));
  const handlerRequiredArguments = Object.fromEntries(Object.entries(handlerMethodDescriptors).map(([name, methods]) => [name,
    Object.fromEntries(callableMethods(methods).map(([method, descriptor]) => [method, descriptor.requiredArguments]))]));
  const classHeader = tokens(text.slice(owner.getStart(source), owner.members.pos));
  const topLevel = source.statements.filter(node => node !== owner).map(node => tokens(node.getText(source)));
  const bodies = Object.create(null);
  const delegationBodies = Object.create(null);
  const forwarding = [];
  for (const method of owner.members) {
    assert.ok(ts.isMethodDeclaration(method) || ts.isConstructorDeclaration(method), 'unsupported class member');
    assert.ok(method.body);
    if (ts.isMethodDeclaration(method)) assert.ok(ts.isIdentifier(method.name), 'unsupported method name');
    const name = ts.isConstructorDeclaration(method) ? 'constructor' : method.name.text;
    assert.equal(Object.hasOwn(bodies, name) || forwarding.includes(name), false, `duplicate method ${name}`);
    const statements = method.body.statements;
    let delegated = false;
    if (statements.length === 1 && ts.isReturnStatement(statements[0]) && statements[0].expression && ts.isCallExpression(statements[0].expression)) {
      const call = statements[0].expression;
      let target = call.expression;
      let optional = false;
      function checkOptional(node) {
        if (node.questionDotToken) optional = true;
        ts.forEachChild(node, checkOptional);
      }
      checkOptional(call.expression);
      if (ts.isPropertyAccessExpression(target) && ['call', 'apply'].includes(target.name.text)) target = target.expression;
      const parameters = new Set();
      function bind(name) {
        if (ts.isIdentifier(name)) parameters.add(name.text);
        else for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name);
      }
      for (const parameter of method.parameters) bind(parameter.name);
      const direct = argument => ts.isIdentifier(argument) && (parameters.has(argument.text) || argument.text === 'arguments');
      delegated = !optional && !call.questionDotToken && ts.isPropertyAccessExpression(target) && !target.questionDotToken &&
        ts.isIdentifier(target.expression) && handlers.has(target.expression.text) && !parameters.has(target.expression.text) &&
        call.arguments.length > 0 && call.arguments[0].kind === ts.SyntaxKind.ThisKeyword &&
        call.arguments.slice(1).every(argument => direct(argument) || (ts.isSpreadElement(argument) && direct(argument.expression)));
    }
    if (delegated) {
      forwarding.push(name);
      delegationBodies[name] = tokens(method.getText(source));
    }
    else bodies[name] = crypto.createHash('sha256').update(JSON.stringify(tokens(method.getText(source)))).digest('hex');
  }
  return { handlers: [...handlers].sort(), unapprovedHandlers, handlerMethods, handlerContracts, handlerRequiredArguments,
    forwarding: forwarding.sort(), delegationBodies, topLevel, classHeader, bodies };
}

function compact(raw) {
  const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    handlers: raw.handlers,
    forwarding: raw.forwarding,
    delegationBodies: Object.fromEntries(Object.entries(raw.delegationBodies).map(([name, value]) => [name, fingerprint(value)])),
    topLevel: fingerprint(raw.topLevel),
    classHeader: fingerprint(raw.classHeader),
    bodies: raw.bodies
  };
}

function parameterShape(method, source) {
  return method.parameters.map(parameter => tokens(parameter.getText(source)));
}

const PRIOR_UNSUPPORTED_FORWARDING_SHAPES = new Map([
  ['listTopicPublications', ['channelId = null']],
  ['bindingInput', ['binding', 'existing = null']],
  ['bind', ['binding', 'options = {}']],
  ['_bindOrdinary', ['binding', 'identity', 'adoptionCutoff = null', 'options = {}']],
  ['_rebindOrdinary', ['binding', 'identity', 'nativeProof = null', 'intakeCutoff = null', 'options = {}']],
  ['enrollThread', ['input', 'expectedBinding = null']],
  ['listThreadEnrollments', ['parentChannelId = null']],
  ['deactivateThreadEnrollments', ['parentChannelId', 'expectedBinding = null']],
  ['setThreadBaseline', ['threadId', 'latestId', 'expectedBinding = null', 'expectedEnrollment = undefined']],
  ['checkpointThread', ['threadId', 'coverageId', 'expectedBinding = null', 'expectedEnrollment = undefined']],
  ['findNativeBinding', ['nativeId', 'provider = null']],
  ['setBindingReadiness', ['channelId', 'readiness', 'detail = null', 'expectedBinding = null']],
  ['assertNativeOwnerFree', ['provider', 'nativeId', 'channelId = null']],
  ['assertConductorOwnerFree', ['provider', 'conductorId', 'channelId = null']],
  ['upsertIntakeWatermark', ['event', 'ready', 'coverageId = null']],
  ['checkpointIntake', ['channelId', 'coverageId', 'expectedBinding = null']],
  ['setIntakeBaseline', ['channelId', 'lastSeenId', 'detail', 'expectedBinding = null', 'expectedBoundary = undefined', 'expectedReadiness = undefined']],
  ['setIntakeCutoff', ['channelId', 'guildId', 'lastSeenId', 'detail', 'expectedBinding = undefined']],
  ['setIntakeCutoffInTransaction', ['channelId', 'guildId', 'lastSeenId', 'detail', 'expectedBinding = undefined']],
  ['markIntakeBoundary', ['channelId', 'state', 'detail = null', 'gapFrom = null', 'gapTo = null', 'expectedBinding = null', 'pauseMetadata = null', 'expectedBoundary = undefined', 'expectedReadiness = undefined']],
  ['recordTopicPublication', ['channelId', 'publication', 'expectedBinding = null']],
  ['reconcileTopicPublication', ['channelId', 'requestId', 'resolution', 'evidenceScope', 'readback = null']],
  ['acceptInteraction', ['input', 'expectedBinding = null', 'options = {}']],
  ['recordInteractionCallbackOutcome', ['messageId', 'outcome', 'detail = {}']],
  ['recordDecisionPresentationOutcome', ['presentationId', 'outcome', 'messageId = null']],
  ['getTransportReceipt', ['messageId', 'transport = null']],
  ['beginTransportReceipt', ['messageId', 'options = {}']],
  ['recordTransportReceiptOutcome', ['messageId', 'outcome', 'detail = {}', 'transport = null']],
  ['markSubmitted', ['messageId', 'cursor = null', 'marker = null']],
  ['setObserverCursor', ['messageId', 'cursor', 'marker = null']],
  ['releaseNativeReplyFilePreparation', ['messageId', 'preparationId', 'partIndex = 0']],
  ['markReplyFailure', ['messageId', 'error', 'unknown = false', 'partIndex = null']],
  ['reconcileReplyDelivery', ['messageId', 'resolution', 'options = {}']],
  ['recoverAfterRestart', ['ownerAlive = null']],
  ['recoverDirectPostReceipts', ['ownerAlive = undefined']],
  ['recoverDirectPostReceiptsInternal', ['ownerAlive = undefined']],
  ['recoverBoardRefreshReceipts', ['ownerAlive = (pid, identity) => this.directPostOwnerEvidence(pid, identity)']],
  ['recoverBoardRefreshAttempt', ['target', 'attemptId', 'ownerAlive = (pid, identity) => this.directPostOwnerEvidence(pid, identity)']],
  ['recordBoardRefreshOutcome', ['target', 'attemptId', 'outcome', 'detail = {}']],
  ['recordDirectPostPreflight', ['meta', 'outcome', 'detail = {}']],
  ['recordDirectPostOutcome', ['requestId', 'attemptId', 'outcome', 'detail = {}']],
  ['reconcileDirectPostOutcome', ['requestId', 'attemptId', 'resolution', 'evidence = {}']],
  ['recoveryCandidates', ['before = null']],
  ['completeProvisionIntent', ['provider', 'nativeId', 'channelId', 'conductorId = null']]
]);

const PRIOR_UNSUPPORTED_FORWARDING_NAMES = new Set(PRIOR_UNSUPPORTED_FORWARDING_SHAPES.keys());

const PRIOR_SURFACE_METHOD_NAMES = new Set([
  'constructor',
  'bindOrdinary',
  'bindOrdinaryClaude',
  'rebindOrdinary',
  'rebindOrdinaryClaude',
  'isOrdinaryBindingRecord',
  'isOrdinaryBinding',
  'hasOrdinaryPreflight',
  'recordOrdinaryPreflight',
  'findOrdinaryHandoff',
  'handoffOrdinary',
  'transaction',
  '_bindOrdinaryClaude',
  '_rebindOrdinaryClaude',
  '_isOrdinaryBindingRecord',
  '_isOrdinaryBinding',
  '_hasOrdinaryPreflight',
  '_recordOrdinaryPreflight',
  'setThreadBoundaryObserver',
  '_notifyThreadBoundaryTransition',
  '_hasActiveThreadEnrollments',
  'markThreadBoundary',
  'noteThreadMessage',
  '_findOrdinaryHandoff',
  'hasUnresolved',
  'hasDispatching',
  'hasSubmitted',
  'hasUncertain',
  'hasUnresolvedBindingPost',
  'hasUnresolvedOrdinaryPost',
  'reject',
  'listIntakeWatermarks',
  'pauseOrdinaryHandoffIntake',
  'restoreOrdinaryHandoffIntake',
  'recoverInterruptedOrdinaryHandoffIntake',
  'reconcileIntake',
  'acceptDiscordMessage',
  'acceptDecisionInteraction',
  'isInteractionMessage',
  'recoverInteractionCallbacksInTransaction',
  'directPostRows',
  'getBindingReadinessReceipt',
  'listAgentCompletionReceipts',
  'listAgentMessageReceiptIds',
  'releaseDirectPostFilePreparation',
  'directPostOwnerIdentity',
  'directPostOwnerEvidence',
  'directPostOwnerAlive',
  'directPostBindingCurrent',
  'listReceipts',
  'receipt',
  'auditReceipt',
  'failNextIntake',
  'close'
]);

function matches(text, baseline) {
  try {
    const raw = inventory(text);
    if (raw.unapprovedHandlers.length) return false;
    const candidate = compact(raw);
    if (Object.keys(candidate.bodies).some(name =>
      !PRIOR_SURFACE_METHOD_NAMES.has(name) && !baseline.forwarding.includes(name))) return false;
    if (JSON.stringify(candidate.handlers) !== JSON.stringify(baseline.handlers) ||
        JSON.stringify(candidate.forwarding) !== JSON.stringify(baseline.forwarding) ||
        JSON.stringify(candidate.topLevel) !== JSON.stringify(baseline.topLevel) ||
        JSON.stringify(candidate.classHeader) !== JSON.stringify(baseline.classHeader) ||
        JSON.stringify(candidate.bodies) !== JSON.stringify(baseline.bodies)) return false;
    for (const name of baseline.forwarding) {
      if (JSON.stringify(candidate.delegationBodies[name]) !== JSON.stringify(baseline.delegationBodies[name])) return false;
    }
    const parsed = ts.createSourceFile('state.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const owner = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'SurfaceState');
    const priorUnsupportedForwarding = PRIOR_UNSUPPORTED_FORWARDING_NAMES;
    for (const method of owner.members) {
      const name = ts.isConstructorDeclaration(method) ? 'constructor' : method.name?.text;
      if (!candidate.forwarding.includes(name)) continue;
      if (ts.isConstructorDeclaration(method)) return false;
      const hasUnsupportedModifiers = !!method.modifiers?.length;
      const hasUnsupportedParameters = method.parameters.some(parameter =>
        parameter.initializer || !ts.isIdentifier(parameter.name));
      const exactLegacyParameterShape = JSON.stringify(parameterShape(method, parsed)) ===
        JSON.stringify((PRIOR_UNSUPPORTED_FORWARDING_SHAPES.get(name) || []).map(text => tokens(text)));
      const grandfatheredParameterShape = hasUnsupportedParameters &&
        baseline.forwarding.includes(name) &&
        priorUnsupportedForwarding.has(name) &&
        exactLegacyParameterShape;
      if (hasUnsupportedModifiers || (hasUnsupportedParameters && !grandfatheredParameterShape)) return false;
      const call = method.body.statements[0].expression;
      const dispatch = call.expression;
      if (method.asteriskToken || !ts.isPropertyAccessExpression(dispatch)) return false;
      const target = ['call', 'apply'].includes(dispatch.name.text) ? dispatch.expression : dispatch;
      if (!ts.isPropertyAccessExpression(target) || !ts.isIdentifier(target.expression) ||
          !raw.handlerMethods[target.expression.text]?.includes(target.name.text)) return false;
      const style = raw.handlerContracts[target.expression.text]?.[target.name.text];
      const requiredArguments = raw.handlerRequiredArguments[target.expression.text]?.[target.name.text] || 0;
      const parameterNames = method.parameters.map(parameter => parameter.name.text);
      const argumentTexts = call.arguments.slice(1).map(argument => argument.getText(parsed));
      const restApply = dispatch.name.text === 'apply' && method.parameters.length === 1 &&
        !!method.parameters[0].dotDotDotToken && argumentTexts.length === 1 && argumentTexts[0] === parameterNames[0];
      const restCall = dispatch.name.text === 'call' && method.parameters.length === 1 &&
        !!method.parameters[0].dotDotDotToken && argumentTexts.length === 1 &&
        argumentTexts[0] === `...${parameterNames[0]}`;
      const orderedCall = dispatch.name.text === 'call' && method.parameters.every(parameter => !parameter.dotDotDotToken) &&
        JSON.stringify(argumentTexts) === JSON.stringify(parameterNames);
      const argumentsApply = dispatch.name.text === 'apply' && method.parameters.every(parameter => !parameter.dotDotDotToken) &&
        argumentTexts.length === 1 && argumentTexts[0] === 'arguments';
      const directCall = dispatch.name.text !== 'call' && dispatch.name.text !== 'apply' &&
        call.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword &&
        argumentTexts.length === parameterNames.length &&
        argumentTexts.every((argument, index) => {
          const parameter = method.parameters[index];
          const parameterName = parameter.name.text;
          return parameter.dotDotDotToken ? argument === `...${parameterName}` : argument === parameterName;
        });
      const argumentsSpread = dispatch.name.text !== 'call' && dispatch.name.text !== 'apply' &&
        call.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword &&
        argumentTexts.length === 1 && argumentTexts[0] === '...arguments';
      let matchesStyle = false;
      if (style === INVOCATION_STYLES.THIS) {
        matchesStyle = (restApply || restCall || orderedCall || argumentsApply) &&
          (restApply || restCall || argumentsApply || method.parameters.length >= requiredArguments);
      }
      else if (style === INVOCATION_STYLES.STATE) {
        matchesStyle = (directCall || argumentsSpread) &&
          (argumentsSpread || method.parameters.some(parameter => parameter.dotDotDotToken) ||
            method.parameters.length >= requiredArguments);
      }
      if (!matchesStyle) return false;
    }
    return true;
  }
  catch { return false; }
}

module.exports = { inventory, compact, matches };
