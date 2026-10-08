function createPolicyModuleGraph({
  ts,
  path,
  infos,
  byFile,
  collectBindings,
  unwrapPolicyExpression,
  policyPropertyKey,
  isAncestor,
  nearestLexicalScope,
  scopeDepth,
  variableDeclarationScope,
  functionBinding,
  bindingName,
  enclosingFunction,
}) {
  const resolveModule = (info, specifier) => {
    if (!specifier || !specifier.startsWith('.')) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(info.file), specifier));
    const sourceCandidates = [];
    const extension = path.posix.extname(base);
    const sourceExtension = {
      '.js': '.ts',
      '.cjs': '.cts',
      '.mjs': '.mts',
    }[extension];
    sourceCandidates.push(
      base,
      base + '.ts',
      base + '.js',
      base + '.cts',
      base + '.mts',
      base + '.cjs',
      base + '.mjs',
      base + '/index.ts',
      base + '/index.js',
      base + '/index.cts',
      base + '/index.mts',
      base + '/index.cjs',
      base + '/index.mjs',
    );
    if (sourceExtension) {
      sourceCandidates.unshift(base.slice(0, -extension.length) + sourceExtension);
    }
    for (const candidate of sourceCandidates) {
      if (byFile.has(candidate)) return byFile.get(candidate);
    }
    return null;
  };
  const resolveExportedFunction = (info, name, seen = new Set()) => {
    const marker = `${info.file}\u0000${name}`;
    if (seen.has(marker)) return null;
    seen.add(marker);
    const exported = info.exports.get(name);
    if (exported && typeof exported === 'object') {
      if (exported.node) return exported;
      if (exported.kind === 'reexport') {
        const target = resolveModule(info, exported.specifier);
        return target ? resolveExportedFunction(target, exported.imported, seen) : null;
      }
    }
    for (const specifier of info.starExports) {
      const target = resolveModule(info, specifier);
      const resolved = target ? resolveExportedFunction(target, name, seen) : null;
      if (resolved) return resolved;
    }
    const localName = typeof exported === 'string' ? exported : name;
    const local = info.functions.get(localName);
    if (local) return local;
    const alias = info.bindings.find(binding => binding.name === localName &&
      binding.kind === 'value' && binding.source && ts.isIdentifier(binding.source));
    return alias ? resolveExportedFunction(info, alias.source.text, seen) : null;
  };
  const resolveImported = (info, name) => {
    const imported = info.imports.get(name);
    if (!imported || imported.namespace) return null;
    const target = resolveModule(info, imported.specifier);
    if (!target) return null;
    return resolveExportedFunction(target, imported.imported);
  };
  for (const info of infos) {
    for (const [name, imported] of info.imports) {
      if (!imported.namespace) {
        const fn = resolveImported(info, name);
        if (fn) info.functions.set(name, fn);
      }
    }
  }

  const resolveFunction = (info, node, seen = new Set()) => {
    const expression = unwrapPolicyExpression(node);
    if (!expression) return null;
    if (ts.isIdentifier(expression)) {
      const binding = findBinding(info, expression.text, expression);
      if (binding?.kind === 'value' && binding.source && !seen.has(binding)) {
        seen.add(binding);
        const aliased = resolveFunction(info, binding.source, seen);
        if (aliased) return aliased;
      }
      if ((binding?.kind === 'field' || binding?.kind === 'parameter-field') &&
          binding.source && binding.key && ts.isIdentifier(binding.source)) {
        const aliased = (info.objectMethods.get(binding.source.text + '.' + binding.key) || [])[0];
        if (aliased) return aliased;
      }
      const overloadScope = binding && ts.isFunctionDeclaration(binding.declaration)
        ? nearestLexicalScope(binding.declaration)
        : null;
      const candidates = info.functionDefs.filter(candidate => candidate.name === expression.text &&
        isAncestor(nearestLexicalScope(candidate.node), expression) &&
        (!binding || candidate.node === binding.declaration || candidate.node === binding.source ||
          (overloadScope && nearestLexicalScope(candidate.node) === overloadScope)));
      candidates.sort((left, right) =>
        Number(Boolean(right.node.body)) - Number(Boolean(left.node.body)) ||
        scopeDepth(nearestLexicalScope(right.node)) - scopeDepth(nearestLexicalScope(left.node)));
      if (candidates[0]) return candidates[0];
      if (binding) {
        const local = info.functions.get(expression.text);
        const importedBinding = ['import', 'commonjs-import'].includes(binding.kind) &&
          info.imports.has(expression.text);
        if (local && (local.node === binding.declaration || local.node === binding.source ||
            importedBinding)) {
          return local;
        }
        return null;
      }
      return info.functions.get(expression.text) || resolveImported(info, expression.text);
    }
    if ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        (ts.isIdentifier(expression.expression) || ts.isNewExpression(expression.expression) ||
          (ts.isCallExpression(expression.expression) && ts.isIdentifier(expression.expression.expression)))) {
      const property = policyPropertyKey(expression);
      if (!property) return null;
      let receiverName = null;
      let receiverBinding = null;
      let receiverClass = null;
      if (ts.isIdentifier(expression.expression)) {
        receiverName = expression.expression.text;
        receiverBinding = findBinding(info, receiverName, expression.expression);
        if (receiverBinding?.source && ts.isNewExpression(receiverBinding.source) &&
            ts.isIdentifier(receiverBinding.source.expression)) {
          receiverClass = receiverBinding.source.expression.text;
        }
      } else if (ts.isNewExpression(expression.expression) &&
          ts.isIdentifier(expression.expression.expression)) {
        receiverClass = expression.expression.expression.text;
      }
      if (receiverClass) {
        const localMethods = info.objectMethods.get(`${receiverClass}.${property}`) || [];
        const localMethod = localMethods
          .filter(method => method.instance &&
            (!receiverBinding || method.ownerDeclaration === receiverBinding.declaration ||
              method.ownerDeclaration?.name?.text === receiverClass))
          .sort((left, right) =>
            scopeDepth(nearestLexicalScope(right.node)) - scopeDepth(nearestLexicalScope(left.node)))[0];
        if (localMethod) return localMethod;
      }
      if (receiverName) {
        const key = receiverName + '.' + property;
        const localMethods = info.objectMethods.get(key) || [];
        const localMethod = localMethods
          .filter(method => !method.instance &&
            (!receiverBinding || method.ownerDeclaration === receiverBinding.declaration))
          .sort((left, right) =>
            scopeDepth(nearestLexicalScope(right.node)) - scopeDepth(nearestLexicalScope(left.node)))[0];
        if (localMethod) return localMethod;
        const imported = info.imports.get(receiverName);
        const importBinding = receiverBinding?.kind;
        if (imported && (!receiverBinding || importBinding === 'namespace-import' ||
            importBinding === 'commonjs-import' || imported.imported === 'default')) {
          const target = resolveModule(info, imported.specifier);
          return target ? resolveExportedFunction(target, property) : null;
        }
      }
      if (ts.isCallExpression(expression.expression) &&
          ts.isIdentifier(expression.expression.expression) &&
          expression.expression.expression.text === 'require' &&
          expression.expression.arguments.length === 1 &&
          ts.isStringLiteralLike(expression.expression.arguments[0])) {
        const target = resolveModule(info, expression.expression.arguments[0].text);
        return target ? resolveExportedFunction(target, property) : null;
      }
    }
    return null;
  };
  for (const info of infos) {
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const callMethod = ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'call';
        const callReceiver = callMethod ? resolveFunction(info, node.expression.expression) : null;
        const fn = callReceiver || resolveFunction(info, node.expression);
        const args = callReceiver ? node.arguments.slice(1) : node.arguments;
        if (fn) fn.calls.push({ info, args, node });
      }
      ts.forEachChild(node, visit);
    };
    visit(info.ast);
  }

  function findBinding(info, name, node) {
    const bindings = info.bindings.filter(binding => binding.name === name &&
      (!binding.scope || isAncestor(binding.scope, node) || binding.scope === node));
    const priority = binding => ['import', 'namespace-import', 'commonjs-import'].includes(binding.kind) ? 1 : 0;
    bindings.sort((left, right) =>
      scopeDepth(right.scope) - scopeDepth(left.scope) || priority(right) - priority(left));
    return bindings[0] || null;
  }
  const bindingCalls = (binding, fallbackInfo) => {
    if (!binding.function) return [];
    const ownerInfo = binding.ownerInfo || fallbackInfo;
    const functionInfo = ownerInfo.functionDefs.find(candidate => candidate.node === binding.function);
    return functionInfo?.calls || [];
  };

  return {
    resolveModule,
    resolveExportedFunction,
    resolveImported,
    resolveFunction,
    findBinding,
    bindingCalls,
  };
}

module.exports = { createPolicyModuleGraph };
