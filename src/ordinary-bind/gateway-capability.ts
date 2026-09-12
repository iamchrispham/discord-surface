const { GATEWAY_CAPABILITIES } = require('../../src/ordinary-bind/constants') as {
  GATEWAY_CAPABILITIES: {
    ordinaryBindWake: string;
  };
};

export interface GatewayStatus {
  state?: string | null;
  pid?: number | null;
  capabilities?: readonly string[] | null;
}

export type GatewayStatusReader<TPaths> = (paths: TPaths) => GatewayStatus | null | undefined;

export function assertGatewayWakeCompatible<TPaths>(
  paths: TPaths,
  status: GatewayStatusReader<TPaths>,
  runtime: GatewayStatus | null | undefined = undefined
): GatewayStatus {
  const snapshot = runtime || status(paths);
  if (!snapshot || snapshot.state === 'unknown') {
    throw new Error('Gateway status is unknown; stop or restart it before binding');
  }
  if (snapshot.state !== 'running' || !snapshot.pid || snapshot.capabilities?.includes(GATEWAY_CAPABILITIES.ordinaryBindWake)) return snapshot;
  throw new Error('running Gateway does not support ordinary binding wake; stop or restart it before binding');
}
