const os = require('node:os');
const { resolveDedupeKey, resolveDirectBinding } = require('../direct-post');
const { runBoardRefresh } = require('../board-refresh');
const { BOARD_OUTCOMES } = require('../state');
const { readSecret } = require('../discord');

function createBoardRefreshCommands({ required, openState, print }) {
  async function boardRefresh(args) {
    const { state } = openState(args);
    const controller = new AbortController();
    let receivedSignal = null;
    const handleSignal = signal => {
      if (receivedSignal) return;
      receivedSignal = signal;
      controller.abort();
    };
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
    try {
      const config = state.requireConfig();
      const result = await runBoardRefresh({
        state,
        token: readSecret(config.secretFile),
        nativeId: required(args, 'native-id'),
        generation: required(args, 'generation'),
        channelId: required(args, 'channel-id'),
        messageId: required(args, 'message-id'),
        textFile: required(args, 'text-file'),
        dedupeKey: resolveDedupeKey({ dedupeKey: args['dedupe-key'], requestId: args['request-id'] }, { required: true }),
        signal: controller.signal,
        resolveBinding: (surfaceState, input) => resolveDirectBinding(surfaceState, {
          nativeId: input.nativeId,
          generation: input.generation,
          channelId: input.channelId,
          provider: null,
          ordinary: false
        })
      });
      print(result);
      if (![BOARD_OUTCOMES.APPLIED, BOARD_OUTCOMES.NO_OP].includes(result.status)) process.exitCode = 1;
      if (receivedSignal) process.exitCode = 128 + (os.constants.signals?.[receivedSignal] || 1);
      return result;
    } catch (error) {
      if (!receivedSignal || !controller.signal.aborted) throw error;
      process.exitCode = 128 + (os.constants.signals?.[receivedSignal] || 1);
    } finally {
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
      state.close();
    }
  }

  return { boardRefresh };
}

module.exports = { createBoardRefreshCommands };
