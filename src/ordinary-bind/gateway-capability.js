const { GATEWAY_CAPABILITIES } = require('./constants');

function assertGatewayWakeCompatible(paths, status, runtime = undefined) {
  const snapshot = runtime || status(paths);
  if (!snapshot || snapshot.state === 'unknown') {
    throw new Error('Gateway status is unknown; stop or restart it before binding');
  }
  if (snapshot.state !== 'running' || !snapshot.pid || snapshot.capabilities?.includes(GATEWAY_CAPABILITIES.ordinaryBindWake)) return snapshot;
  throw new Error('running Gateway does not support ordinary binding wake; stop or restart it before binding');
}

module.exports = { assertGatewayWakeCompatible };
