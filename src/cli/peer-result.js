const { createPeerService } = require('../peer/service');
const { completeCommandCleanup } = require('./command-cleanup');

function createPeerResultCommand({ required, openState, print, resolveCurrentClaudeCaller }) {
  return async function peerResult(args, dependencies = {}) {
    const provider = required(args, 'provider');
    const correlationId = required(args, 'correlation-id');
    const { state } = openState(args);
    let hadBodyFailure = false;
    try {
      const result = await createPeerService({
        state,
        provider,
        callerDependencies: { resolveClaudeCaller: resolveCurrentClaudeCaller, ...dependencies.callerDependencies }
      }).result(correlationId);
      print(result);
      return result;
    } catch (error) {
      hadBodyFailure = true;
      throw error;
    } finally {
      await completeCommandCleanup([() => state.close()], hadBodyFailure);
    }
  };
}

module.exports = { createPeerResultCommand };
